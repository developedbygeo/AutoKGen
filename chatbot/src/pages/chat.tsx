import { useState, useCallback, type KeyboardEvent } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useDbStatus } from '@/hooks/use-db-status';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ui/conversation';
import { MessageBubble } from '@/components/chat/message-bubble';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { BotIcon, DatabaseIcon, SendHorizontalIcon, SquareIcon, Trash2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';

const transport = new DefaultChatTransport({ api: '/api/chat' });

export default function ChatPage() {
  const { messages, sendMessage, status, stop, setMessages, error } = useChat({
    transport,
    onError: (err) => {
      console.error('[useChat] error:', err);
    },
  });

  const db = useDbStatus();
  const isLoading = status === 'streaming' || status === 'submitted';

  const [input, setInput] = useState('');

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    sendMessage({ text: trimmed });
    setInput('');
  }, [input, isLoading, sendMessage]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="flex h-dvh flex-col bg-background">
      {/* Header */}
      <header className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <BotIcon className="size-5 text-primary" />
          <h1 className="text-lg font-semibold">Agentic KG chat</h1>
        </div>

        <div className="flex items-center gap-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={db.refresh}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
                >
                  <DatabaseIcon className="size-3.5" />
                  <span
                    className={cn(
                      'size-2 rounded-full',
                      db.status === 'connected' && 'bg-green-500',
                      db.status === 'disconnected' && 'bg-red-500',
                      db.status === 'checking' && 'bg-yellow-500 animate-pulse',
                    )}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {db.status === 'connected' && `Neo4j connected (${db.latencyMs}ms)`}
                {db.status === 'disconnected' && `Neo4j disconnected: ${db.error}`}
                {db.status === 'checking' && 'Checking Neo4j...'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {messages.length > 0 && (
            <Button variant="ghost" size="icon-xs" onClick={() => setMessages([])} aria-label="Clear chat">
              <Trash2Icon className="size-3.5" />
            </Button>
          )}
        </div>
      </header>

      {/* Conversation area */}
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto max-w-3xl">
          {messages.length === 0 ? (
            <ConversationEmptyState
              icon={<BotIcon className="size-8" />}
              title="How can I help you?"
              description="Ask me anything about your knowledge graph."
            />
          ) : (
            <>
              {messages.map((message, index) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  isStreaming={isLoading && message.role === 'assistant' && index === messages.length - 1}
                />
              ))}

              {/* Thinking indicator — shows after user sends, before assistant bubble appears */}
              {status === 'submitted' && messages[messages.length - 1]?.role === 'user' && (
                <div className="flex items-start gap-3 py-3">
                  <Avatar size="sm">
                    <AvatarFallback className="bg-muted text-muted-foreground">
                      <BotIcon className="size-3.5" />
                    </AvatarFallback>
                  </Avatar>
                  <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-2.5">
                    <div className="flex items-center gap-1">
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Error bar */}
      {error && (
        <div className="border-t border-destructive/20 bg-destructive/10 px-4 py-2 text-center text-sm text-destructive">
          {error.message}
        </div>
      )}

      {/* Input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
        className="border-t bg-background p-4"
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            className="min-h-10 max-h-40 resize-none"
            rows={1}
            disabled={isLoading}
            autoFocus
          />
          {isLoading ? (
            <Button
              type="button"
              variant="destructive"
              size="icon"
              onClick={stop}
              aria-label="Stop generating"
            >
              <SquareIcon className="size-4" />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!input.trim()} aria-label="Send message">
              <SendHorizontalIcon className="size-4" />
            </Button>
          )}
        </div>
        <p className="mx-auto mt-2 max-w-3xl text-center text-xs text-muted-foreground">
          Press Enter to send, Shift + Enter for a new line
        </p>
      </form>
    </div>
  );
}
