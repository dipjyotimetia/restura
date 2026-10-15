import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { importedSchemaToResult } from '../../lib/schemaImport';
import SchemaExplorer from '../SchemaExplorer';

const schema = importedSchemaToResult(
  { sdl: 'type Query { hello: String }', source: 'sdl', importedAt: 1 },
  'https://api.example/graphql'
).schema;

describe('SchemaExplorer import controls', () => {
  it('shows the IMPORTED pill and provenance instead of LOADED for an imported schema', () => {
    const onClearImported = vi.fn();
    render(
      <SchemaExplorer
        schema={schema}
        loaded
        importedFrom="From api.graphqls"
        onClearImported={onClearImported}
      />
    );

    expect(screen.getByText('IMPORTED')).toBeTruthy();
    expect(screen.queryByText('LOADED')).toBeNull();
    expect(screen.getByText('From api.graphqls')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove imported schema' }));
    expect(onClearImported).toHaveBeenCalledTimes(1);
  });

  it('shows provenance without a Remove control when clearing is not offered', () => {
    render(<SchemaExplorer schema={schema} importedFrom="From pasted SDL" />);
    expect(screen.getByText('From pasted SDL')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove imported schema' })).toBeNull();
  });

  it('shows LOADED for an introspected schema and no pill before one is loaded', () => {
    const { rerender } = render(<SchemaExplorer schema={schema} loaded />);
    expect(screen.getByText('LOADED')).toBeTruthy();
    expect(screen.queryByText('IMPORTED')).toBeNull();

    rerender(<SchemaExplorer schema={null} />);
    expect(screen.queryByText('LOADED')).toBeNull();
    expect(screen.getByText(/load an SDL \/ introspection JSON file/)).toBeTruthy();
  });

  it('offers the Load schema button only when an import handler is given', () => {
    const onImport = vi.fn();
    const { rerender } = render(<SchemaExplorer schema={null} onImport={onImport} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load schema file or SDL' }));
    expect(onImport).toHaveBeenCalledTimes(1);

    rerender(<SchemaExplorer schema={null} />);
    expect(screen.queryByRole('button', { name: 'Load schema file or SDL' })).toBeNull();
  });
});

const richSchema = importedSchemaToResult(
  {
    sdl: /* GraphQL */ `
      type Query {
        user(id: ID!): User
        search(filter: UserFilter): [Node!]!
      }
      type Mutation {
        renameUser(id: ID!, name: String!): User
      }
      type Subscription {
        userChanged: User
      }
      interface Node {
        id: ID!
      }
      type User implements Node {
        id: ID!
        name: String!
        role: Role
      }
      input UserFilter {
        role: Role
      }
      enum Role {
        ADMIN
        MEMBER
      }
      scalar DateTime
    `,
    source: 'sdl',
    importedAt: 1,
  },
  'https://api.example/graphql'
).schema;

describe('SchemaExplorer type list', () => {
  const typeRow = (name: string) => screen.getByText(name, { selector: 'span.font-mono' });

  it('lists root operation types first, then every named type with its kind', () => {
    render(<SchemaExplorer schema={richSchema} />);
    for (const label of ['query', 'mutation', 'subscription']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    for (const name of ['Node', 'User', 'UserFilter', 'Role', 'DateTime']) {
      expect(typeRow(name)).toBeTruthy();
    }
    for (const badge of ['INTERFACE', 'INPUT', 'ENUM', 'SCALAR']) {
      expect(screen.getAllByText(badge).length).toBeGreaterThan(0);
    }
  });

  it('expands a type to its fields, selects a field, and collapses again', () => {
    const onFieldSelect = vi.fn();
    render(<SchemaExplorer schema={richSchema} onFieldSelect={onFieldSelect} />);
    expect(screen.queryByText('renameUser')).toBeNull();

    fireEvent.click(typeRow('Mutation'));
    fireEvent.click(screen.getByText('renameUser'));
    expect(onFieldSelect).toHaveBeenCalledWith('renameUser');
    expect(screen.getByText('User', { selector: 'span.text-sp-dim' })).toBeTruthy();

    fireEvent.click(typeRow('Mutation'));
    expect(screen.queryByText('renameUser')).toBeNull();
  });

  it('does not expand a type without fields', () => {
    render(<SchemaExplorer schema={richSchema} />);
    fireEvent.click(typeRow('DateTime'));
    expect(screen.queryByText('ADMIN')).toBeNull();
  });

  it('filters by type name or field name and auto-expands matching fields', () => {
    render(<SchemaExplorer schema={richSchema} />);
    const filter = screen.getByRole('textbox');

    fireEvent.change(filter, { target: { value: 'rename' } });
    expect(screen.getByText('renameUser')).toBeTruthy();
    expect(screen.queryByText('Query', { selector: 'span.font-mono' })).toBeNull();

    fireEvent.change(filter, { target: { value: 'userfilter' } });
    expect(typeRow('UserFilter')).toBeTruthy();
    expect(screen.queryByText('Mutation', { selector: 'span.font-mono' })).toBeNull();

    fireEvent.change(filter, { target: { value: 'no-such-thing' } });
    expect(screen.queryByText('Query', { selector: 'span.font-mono' })).toBeNull();
  });

  it('shows a loading state and disables refresh while introspecting', () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<SchemaExplorer schema={null} loading onRefresh={onRefresh} />);
    expect(screen.getByText('Loading schema…')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Refresh schema' }) as HTMLButtonElement).disabled
    ).toBe(true);

    rerender(<SchemaExplorer schema={null} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh schema' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

const extendedSchema = importedSchemaToResult(
  {
    sdl: /* GraphQL */ `
      type Query {
        user(id: ID!): User
        legacyUser: User @deprecated(reason: "Use user")
      }
      type User {
        id: ID!
        seenAt: DateTime
      }
      input Lookup @oneOf {
        id: ID
        email: String
      }
      input Paging {
        limit: Int
        first: Int @deprecated(reason: "Use limit")
      }
      scalar DateTime @specifiedBy(url: "https://scalars.graphql.org/andimarek/date-time")
    `,
    source: 'sdl',
    importedAt: 1,
  },
  'https://api.example/graphql'
).schema;

describe('SchemaExplorer extended introspection metadata', () => {
  const typeRow = (name: string) => screen.getByText(name, { selector: 'span.font-mono' });

  it('marks deprecated fields with their reason', () => {
    render(<SchemaExplorer schema={extendedSchema} />);
    fireEvent.click(typeRow('Query'));
    const legacy = screen.getByText('legacyUser');
    expect(legacy.className).toContain('line-through');
    expect(legacy.getAttribute('title')).toBe('Deprecated: Use user');
    expect(screen.getByText('user').className).not.toContain('line-through');
  });

  it('expands input objects to their input fields (not selectable) and marks deprecated ones', () => {
    const onFieldSelect = vi.fn();
    render(<SchemaExplorer schema={extendedSchema} onFieldSelect={onFieldSelect} />);
    fireEvent.click(typeRow('Paging'));
    const first = screen.getByText('first');
    expect(first.className).toContain('line-through');
    expect(first.getAttribute('title')).toBe('Deprecated: Use limit');
    fireEvent.click(screen.getByText('limit'));
    expect(onFieldSelect).not.toHaveBeenCalled();
  });

  it('tags @oneOf input objects and scalars with a specifiedBy URL', () => {
    render(<SchemaExplorer schema={extendedSchema} />);
    expect(screen.getByText('@oneOf')).toBeTruthy();
    const spec = screen.getByText('@specifiedBy');
    expect(spec.getAttribute('title')).toBe('https://scalars.graphql.org/andimarek/date-time');
  });
});
