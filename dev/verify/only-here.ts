// Only this machine reaches a run's deploy on AWS. NOT as a real instance: a real instance's CloudFront distributions
// answer everybody. A run's deploy is a test in an account that may hold other work: nobody else on the internet gets
// an answer from any part of it. (The machine is in a private subnet with no public address, as in each deploy:
// CloudFront is its only way in.)
//
//   the stack   <the instance's stack>-only-here, in us-east-1 (where CloudFront's web ACLs are): an AWS WAF web ACL
//               that blocks each request, but for a rule that allows this machine's public address (an IP set), and
//               one for the gate's Lambda, which asks /oauth/token again from AWS's addresses (x-erga-form)
//   restrict    names that web ACL in each CloudFront distribution of the instance's own template, before the stack is
//               made: a distribution never answers without it. It is the one change that a run makes to a template
//
// The address is the one that this machine's requests come from, asked at the start of a deploy, of an update (of a
// deploy that a run kept) and of a check: a changed address changes the IP set. Between them, a kept deploy answers
// the address of its last deploy, update or check.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Where } from "../../deploy/aws/cli.ts";
import { applyStack, CERT_REGION, planStack } from "../../deploy/aws/stack.ts";
import { TEMPLATE_MAX } from "../../deploy/aws/template.ts";
import { sh } from "./run.ts";
import { mine } from "./safe.ts";

export const onlyHereStack = (stack: string) => mine(`${stack}-only-here`);

/**
 * This machine's public addresses, as a server on the internet sees them: IPv4, and IPv6 when the machine has one.
 * It throws when no address is read: a run with no web ACL does not start.
 */
export function addresses(): { v4: string | null; v6: string | null } {
  const ask = (family: "-4" | "-6", url: string) => {
    try {
      return sh(["curl", family, "-s", "--max-time", "8", url]).trim();
    } catch {
      return "";
    }
  };
  const v4 = ask("-4", "https://checkip.amazonaws.com");
  const v6 = ask("-6", "https://ipv6.icanhazip.com");
  const found = { v4: /^\d{1,3}(\.\d{1,3}){3}$/.test(v4) ? v4 : null, v6: /^[0-9a-f:]+:[0-9a-f:]+$/i.test(v6) ? v6 : null };
  if (!found.v4 && !found.v6)
    throw new Error("This machine's public address was not read: the run's deploy would answer nobody, or everybody.");
  return found;
}

/** The stack's template: an IP set for each address, and a web ACL that allows them and blocks all else. Pure. */
export function onlyHereTemplate(name: string, a: { v4: string | null; v6: string | null }) {
  const tags = [{ Key: "erga", Value: name }];
  const sets = [
    ...(a.v4 ? [{ id: "Address4", version: "IPV4", cidr: `${a.v4}/32` }] : []),
    ...(a.v6 ? [{ id: "Address6", version: "IPV6", cidr: `${a.v6}/128` }] : []),
  ];
  const visible = (metric: string) => ({ SampledRequestsEnabled: false, CloudWatchMetricsEnabled: false, MetricName: metric });
  const from = sets.map((s) => ({ IPSetReferenceStatement: { Arn: { "Fn::GetAtt": [s.id, "Arn"] } } }));
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Erga's verify suite: only the machine of the run reaches the run's CloudFront distributions.",
    Resources: {
      ...Object.fromEntries(
        sets.map((s) => [
          s.id,
          {
            Type: "AWS::WAFv2::IPSet",
            Properties: {
              Name: `${name}-${s.version.toLowerCase()}`,
              Scope: "CLOUDFRONT",
              IPAddressVersion: s.version,
              Addresses: [s.cidr],
              Tags: tags,
            },
          },
        ])
      ),
      Acl: {
        Type: "AWS::WAFv2::WebACL",
        Properties: {
          Name: name,
          Scope: "CLOUDFRONT",
          DefaultAction: { Block: {} },
          VisibilityConfig: visible("only-here"),
          Rules: [
            {
              Name: "this-machine",
              Priority: 0,
              Action: { Allow: {} },
              Statement: from.length == 1 ? from[0] : { OrStatement: { Statements: from } },
              VisibilityConfig: visible("this-machine"),
            },
            {
              // The gate's Lambda asks the distribution again, from AWS's addresses, for /oauth/token with its body
              // in x-erga-form (gate/mounts/lambda.ts): /oauth/token and /oauth/register, open paths of the gate's in each deploy.
              Name: "the-gate-lambda",
              Priority: 1,
              Action: { Allow: {} },
              Statement: {
                AndStatement: {
                  Statements: [
                    {
                      ByteMatchStatement: {
                        FieldToMatch: { UriPath: {} },
                        PositionalConstraint: "STARTS_WITH",
                        SearchString: "/oauth/",
                        TextTransformations: [{ Priority: 0, Type: "NONE" }],
                      },
                    },
                    {
                      SizeConstraintStatement: {
                        FieldToMatch: { SingleHeader: { Name: "x-erga-form" } },
                        ComparisonOperator: "GT",
                        Size: 0,
                        TextTransformations: [{ Priority: 0, Type: "NONE" }],
                      },
                    },
                  ],
                },
              },
              VisibilityConfig: visible("the-gate-lambda"),
            },
          ],
          Tags: tags,
        },
      },
    },
    Outputs: { Acl: { Value: { "Fn::GetAtt": ["Acl", "Arn"] } } },
  };
}

/**
 * Makes the stack, or changes its addresses to this machine's of now: the web ACL's ARN. `dir`: where the template's
 * file goes (.erga/). `stack`: the instance's stack.
 */
export async function onlyHere(where: Where, stack: string, dir: string, log: (line: string) => void): Promise<string> {
  const name = onlyHereStack(stack);
  const here = addresses();
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(onlyHereTemplate(name, here), null, 2));
  const plan = await planStack({ ...where, region: CERT_REGION }, name, file);
  const made = await applyStack(plan, log);
  if (!made.outputs.Acl)
    throw new Error(`The stack ${name} has no web ACL: the run's deploy would answer everybody. Nothing more was made.`);
  log(
    `Only this machine (${[here.v4, here.v6].filter(Boolean).join(", ")}) reaches the run's distributions: the web ACL ${name}${plan.changeSet ? "" : ", as before"}.`
  );
  return made.outputs.Acl;
}

/**
 * Names the web ACL in each CloudFront distribution of the instance's template (a file that setup wrote): how many
 * distributions. It throws when the template has none, or gets too long for CloudFormation.
 */
export function restrict(templateFile: string, acl: string): number {
  const template = JSON.parse(readFileSync(templateFile, "utf8")) as {
    Resources: Record<string, { Type: string; Properties: { DistributionConfig: Record<string, unknown> } }>;
  };
  const all = Object.values(template.Resources).filter((r) => r.Type == "AWS::CloudFront::Distribution");
  for (const d of all) d.Properties.DistributionConfig.WebACLId = acl;
  const text = `${JSON.stringify(template, null, 2)}\n`;
  if (!all.length) throw new Error(`${templateFile} has no CloudFront distribution: the web ACL is in front of nothing.`);
  if (Buffer.byteLength(text) > TEMPLATE_MAX)
    throw new Error(`${templateFile} with the web ACL is over CloudFormation's ${TEMPLATE_MAX} bytes.`);
  writeFileSync(templateFile, text);
  return all.length;
}
