// The code of the deployer's Lambda function (deploy/aws/deployer.ts builds this file as its index.js): the deployer
// (deploy/deployer/lambda.ts) with the platform's fetch and the function's own environment.

import { lambda } from "../deployer/lambda";

export const handler = lambda((input, init) => fetch(input, init), process.env);
