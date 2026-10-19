export default function DocsPage({ params }: { params: { slug: string[] } }) {
  return <article>{params.slug.join(' / ')}</article>;
}
