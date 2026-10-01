import { Braces, Variable } from 'lucide-react';
import React, { useRef, useState } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useVariableDetails } from '@/hooks/useVariableStatus';
import { POSTMAN_VARIABLES } from '@/lib/shared/dynamicVariables';
import { variableSourceLabel } from '@/lib/shared/variableScopes';

interface VariableInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  value: string;
  onValueChange: (value: string) => void;
  rawInput?: boolean;
}

export const VariableInput = React.forwardRef<HTMLInputElement, VariableInputProps>(
  (
    { value, onValueChange, rawInput, className, onChange, onKeyDown, onSelect, onBlur, ...props },
    forwardedRef
  ) => {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [insertPosition, setInsertPosition] = useState(0);
    const internalRef = useRef<HTMLInputElement>(null);
    // Every scope the request resolves against (env, globals, collection,
    // folders, script-set keys), not just the active environment.
    const variables = useVariableDetails();

    const checkVariableContext = (text: string, cursorPosition: number) => {
      const beforeCursor = text.slice(0, cursorPosition);
      const lastOpen = beforeCursor.lastIndexOf('{{');
      const lastClose = beforeCursor.lastIndexOf('}}');
      if (lastOpen > lastClose) {
        setOpen(true);
        setSearch(beforeCursor.slice(lastOpen + 2));
        setInsertPosition(lastOpen);
      } else {
        setOpen(false);
      }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      onValueChange(e.target.value);
      checkVariableContext(e.target.value, e.target.selectionStart || 0);
      onChange?.(e);
    };

    const handleSelect = (e: React.SyntheticEvent<HTMLInputElement, Event>) => {
      const target = e.target as HTMLInputElement;
      checkVariableContext(target.value, target.selectionStart || 0);
      onSelect?.(e);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape' && open) {
        setOpen(false);
        e.stopPropagation();
      }
      // Enter belongs to the open picker, not to the field's own handler
      // (e.g. the URL bar's send-on-Enter).
      if (e.key === 'Enter' && open) e.preventDefault();
      onKeyDown?.(e);
    };

    const insertVariable = (varName: string) => {
      const input = internalRef.current;
      const currentPos = input?.selectionStart || value.length;
      const before = value.slice(0, insertPosition);
      const after = value.slice(currentPos);
      const newValue = before + '{{' + varName + '}}' + after;
      onValueChange(newValue);
      setOpen(false);

      setTimeout(() => {
        if (input) {
          const newCursorPos = insertPosition + varName.length + 4;
          input.focus();
          input.setSelectionRange(newCursorPos, newCursorPos);
        }
      }, 0);
    };

    const InputComponent = rawInput ? 'input' : Input;

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <InputComponent
            ref={(node: HTMLInputElement) => {
              internalRef.current = node;
              if (typeof forwardedRef === 'function') forwardedRef(node);
              else if (forwardedRef) forwardedRef.current = node;
            }}
            value={value}
            onChange={handleChange}
            onSelect={handleSelect}
            onKeyDown={handleKeyDown}
            onBlur={onBlur}
            className={className}
            autoComplete="off"
            {...props}
          />
        </PopoverAnchor>
        <PopoverContent
          className="w-[300px] p-0"
          align="start"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Command>
            <CommandInput
              placeholder="Search variables..."
              value={search}
              onValueChange={setSearch}
              className="h-9"
            />
            <CommandList>
              <CommandEmpty>No variables found.</CommandEmpty>
              {variables.length > 0 && (
                <CommandGroup heading="Variables">
                  {variables.map((v) => (
                    <CommandItem
                      key={v.name}
                      value={v.name}
                      onSelect={() => insertVariable(v.name)}
                      className="flex justify-between items-center"
                    >
                      <div className="flex items-center gap-2 overflow-hidden">
                        <Variable className="h-3.5 w-3.5 text-primary shrink-0" />
                        <span className="font-mono text-xs truncate">{v.name}</span>
                      </div>
                      <span className="flex items-center gap-1.5 ml-2 min-w-0 text-xs text-muted-foreground">
                        <span className="truncate max-w-[100px]">
                          {v.secret ? '••••••' : (v.value ?? '')}
                        </span>
                        <span className="shrink-0 opacity-70">{variableSourceLabel(v.source)}</span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              <CommandGroup heading="Dynamic Variables">
                {POSTMAN_VARIABLES.map((v) => (
                  <CommandItem
                    key={v.name}
                    value={v.name}
                    onSelect={() => insertVariable(v.name)}
                    className="flex justify-between items-center"
                  >
                    <div className="flex items-center gap-2 overflow-hidden">
                      <Braces className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                      <span className="font-mono text-xs text-amber-600 dark:text-amber-400 truncate">
                        {v.name}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  }
);
VariableInput.displayName = 'VariableInput';
