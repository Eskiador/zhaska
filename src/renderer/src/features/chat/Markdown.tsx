import { memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock'

/**
 * Markdown de las respuestas del modelo. Sin HTML crudo (react-markdown lo ignora por defecto),
 * enlaces no navegables (la app no abre URLs desde el contenido del modelo) y código resaltado con Monaco.
 */
export const MarkdownView = memo(function MarkdownView({ text }: { text: string }) {
  return (
    <div className="md selectable">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1]
            const code = String(children ?? '')
            if (lang || code.includes('\n')) return <CodeBlock code={code.replace(/\n$/, '')} lang={lang ?? 'plaintext'} />
            return <code className="rounded-sm bg-bg-3 px-1 py-px font-mono text-[12.5px] text-fg-1">{children}</code>
          },
          a: ({ href, children }) => (
            <span className="text-accent underline decoration-dotted underline-offset-2" title={href}>
              {children}
            </span>
          ),
          img: ({ alt }) => <span className="text-fg-3">[imagen: {alt}]</span>,
        }}
      >
        {text}
      </Markdown>
    </div>
  )
})
