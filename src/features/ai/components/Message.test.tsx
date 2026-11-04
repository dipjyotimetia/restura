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

describe('Message states', () => {
  const message = (fields: Partial<ChatMessage>): ChatMessage => ({
    id: 'm2',
    role: 'assistant',
    text: '',
    status: 'done',
    createdAt: 0,
    ...fields,
  });

  it('renders a user message without the AI footer', () => {
    render(<Message message={message({ role: 'user', text: 'Hello there' })} />);
    expect(screen.getByText('Hello there')).toBeTruthy();
    expect(screen.queryByText(/AI can be wrong/)).toBeNull();
  });

  it('shows an ellipsis while an empty reply is streaming, and no footer yet', () => {
    render(<Message message={message({ status: 'streaming' })} />);
    expect(screen.getByText('…')).toBeTruthy();
    expect(screen.queryByText(/AI can be wrong/)).toBeNull();
  });

  it('shows the error message of a failed reply', () => {
    render(
      <Message
        message={message({ status: 'error', text: 'Partial', errorMessage: 'Rate limited' })}
      />
    );
    expect(screen.getByText('Partial')).toBeTruthy();
    expect(screen.getByText('Rate limited')).toBeTruthy();
    expect(screen.queryByText(/AI can be wrong/)).toBeNull();
  });

  it('a failed reply with no error message or text renders nothing extra', () => {
    const { container } = render(<Message message={message({ status: 'error' })} />);
    expect(container.textContent).toBe('');
  });

  it('a finished reply without usage shows only the verification caveat', () => {
    render(<Message message={message({ text: 'Answer' })} />);
    expect(screen.getByText(/AI can be wrong/)).toBeTruthy();
    expect(screen.queryByText(/tok ·/)).toBeNull();
  });
});
