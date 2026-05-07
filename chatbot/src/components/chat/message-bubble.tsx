import type { UIMessage } from 'ai';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Spinner } from '@/components/ui/spinner';
import { ToolCallCard } from '@/components/chat/tool-call-card';
import { BotIcon, UserIcon } from 'lucide-react';

interface MessageBubbleProps {
  message: UIMessage;
  isStreaming?: boolean;
}

export function MessageBubble({ message, isStreaming = false }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  // Separate parts into text and tools
  const textParts = message.parts.filter(
    (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text'
  );
  const toolParts = message.parts.filter(
    (p) => p.type === 'dynamic-tool' || (typeof p.type === 'string' && p.type.startsWith('tool-'))
  );
  const text = textParts.map((p) => p.text).join('');
  const hasContent = text || toolParts.length > 0;

  return (
    <div
      className={cn(
        'flex items-start gap-3 py-3',
        isUser && 'flex-row-reverse'
      )}
    >
      <Avatar size="sm">
        <AvatarFallback
          className={cn(
            isUser
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground'
          )}
        >
          {isUser ? <UserIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}
        </AvatarFallback>
      </Avatar>

      <div className={cn('max-w-[80%]', isUser && 'text-right')}>
        {/* Tool call cards (assistant only) */}
        {!isUser && toolParts.map((part: any) => (
          <ToolCallCard
            key={part.toolCallId}
            toolName={part.toolName}
            state={part.state}
            input={part.input}
            output={'output' in part ? part.output : undefined}
            errorText={'errorText' in part ? part.errorText : undefined}
          />
        ))}

        {/* Text bubble */}
        {(text || (isStreaming && !hasContent)) && (
          <div
            className={cn(
              'rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
              isUser
                ? 'bg-primary text-primary-foreground rounded-tr-sm whitespace-pre-wrap'
                : 'bg-muted text-foreground rounded-tl-sm'
            )}
          >
            {!text ? (
              <Spinner className="size-4" />
            ) : isUser ? (
              text
            ) : (
              <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2 prose-pre:my-1">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    table: ({ children }) => (
                      <div className="my-2 overflow-x-auto">
                        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                          {children}
                        </table>
                      </div>
                    ),
                    th: ({ children }) => (
                      <th style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 600, borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' }}>
                        {children}
                      </th>
                    ),
                    td: ({ children }) => (
                      <td style={{ padding: '0.375rem 0.75rem', borderBottom: '1px solid var(--border)' }}>
                        {children}
                      </td>
                    ),
                  }}
                >
                  {text}
                </Markdown>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
