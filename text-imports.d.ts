// Markdown imported as text (Bun natively; the Worker build through vite.config.ts).
declare module "*.md" {
  const text: string;
  export default text;
}
