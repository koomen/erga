// Markdown imported as text (Bun natively; the Worker build through vite.config.ts).
declare module "*.md" {
  const text: string;
  export default text;
}

// Any file as text, with Vite's ?raw (the Worker build and the dev server only: factory/vm/scripts.ts).
declare module "*?raw" {
  const text: string;
  export default text;
}
