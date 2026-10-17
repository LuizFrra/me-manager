export interface MarkdownViewProps {
  source: string
  /** Path of the .md file relative to the root, used to resolve relative links/images. */
  filePath: string
  loadImage: (relPath: string) => Promise<string | null>
  /** Called with a root-relative path for links to other files inside the root. */
  onOpenLink: (relPath: string) => void
  onOpenExternal: (url: string) => void
}

export function MarkdownView({ source }: MarkdownViewProps): React.JSX.Element {
  return <pre>{source}</pre>
}
