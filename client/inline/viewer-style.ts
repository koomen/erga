// The app's stylesheet on a document's page (server/pages/viewer.ts), for someone who reads: put in by this script, in
// this script's place, so that the scripts after it (the one that starts the document's frame) do not wait for it, as
// they do for a stylesheet in the page's own HTML. The page still paints nothing before it (blocking="render").

export default function viewerStyle(href: string): void {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.setAttribute("blocking", "render");
  document.currentScript!.after(link);
}
