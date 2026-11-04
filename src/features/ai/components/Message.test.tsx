import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/features/ai/store';
import { Message } from './Message';

const reply = (usage: ChatMessage['usage']): ChatMessage =>
  ({
    id: 'm1',
    role: 'assistant',
    text: 'Done.',
    status: 'done',
    createdAt: 0,
    ...(usage ? { usage } : {}),
  }) as ChatMessage;

describe('Message usage footer', () => {
  it('shows the estimated cost of a priced model', () => {
    render(
      <Message
        message={reply({ promptTokens: 3, completionTokens: 2, estimatedCostUSD: 0.0012 })}
      />
    );
    expect(screen.getByText(/3\+2 tok · \$0\.0012/)).toBeTruthy();
  });

  it('shows an unpriced model as cost unknown, never $0', () => {
    render(
      <Message
        message={reply({
          promptTokens: 3,
          completionTokens: 2,
          estimatedCostUSD: 0,
          costUnknown: true,
        })}
      />
    );
    expect(screen.getByText(/cost unknown/)).toBeTruthy();
    expect(screen.queryByText(/\$0\.0000/)).toBeNull();
  });
});
