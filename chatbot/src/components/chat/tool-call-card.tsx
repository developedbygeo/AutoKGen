import { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { CheckIcon, ChevronRightIcon, XIcon, WrenchIcon } from 'lucide-react';

interface ToolCallCardProps {
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

function formatToolName(name: string): string {
  return name.replace(/_/g, ' ');
}

function StatusIcon({ state }: { state: string }) {
  switch (state) {
    case 'output-available':
      return <CheckIcon className="size-3.5 text-green-600" />;
    case 'output-error':
      return <XIcon className="size-3.5 text-destructive" />;
    default:
      return <Spinner className="size-3.5" />;
  }
}

function tryFormatJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

export function ToolCallCard({ toolName, state, input, output, errorText }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const isDone = state === 'output-available' || state === 'output-error';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="my-1.5 rounded-lg border bg-muted/30 text-sm">
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors rounded-lg">
          <ChevronRightIcon
            className={cn(
              'size-3.5 text-muted-foreground shrink-0 transition-transform',
              open && 'rotate-90'
            )}
          />
          <WrenchIcon className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium text-muted-foreground truncate">
            {formatToolName(toolName)}
          </span>
          <span className="ml-auto shrink-0">
            <StatusIcon state={state} />
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="border-t px-3 py-2 space-y-2">
            {input != null && Object.keys(input as object).length > 0 && (
              <div>
                <Badge variant="outline" className="mb-1 text-[10px] px-1.5 py-0">
                  Input
                </Badge>
                <pre className="text-xs text-muted-foreground bg-muted/50 rounded p-2 overflow-x-auto max-h-40">
                  {tryFormatJson(input)}
                </pre>
              </div>
            )}

            {output != null && (
              <div>
                <Badge variant="outline" className="mb-1 text-[10px] px-1.5 py-0">
                  Output
                </Badge>
                <pre className="text-xs text-muted-foreground bg-muted/50 rounded p-2 overflow-x-auto max-h-60">
                  {tryFormatJson(output)}
                </pre>
              </div>
            )}

            {errorText && (
              <div>
                <Badge variant="destructive" className="mb-1 text-[10px] px-1.5 py-0">
                  Error
                </Badge>
                <p className="text-xs text-destructive">{errorText}</p>
              </div>
            )}

            {!isDone && !input && (
              <p className="text-xs text-muted-foreground italic">Executing...</p>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
