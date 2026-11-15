/**
 * JsonLd — structured data (schema.org JSON-LD) in the page's HTML, for
 * search engines and AI systems that read it.
 *
 * A server component: nothing reaches the browser but the script element
 * itself. A data block is not executed, and `<` is escaped so a string in the
 * data can never close the element.
 */

export default function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
