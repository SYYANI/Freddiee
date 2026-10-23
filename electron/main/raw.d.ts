// Text resources bundled into the main process (Vite `?raw` imports), such as the RebuildPDFKit prompts.
declare module '*?raw' {
  const content: string
  export default content
}
