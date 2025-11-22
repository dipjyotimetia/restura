'use client';

import { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { GraphQLSchema } from '../types';
import { getTypesByKind, getRootTypes, getTypeFields, getTypeByName } from '../lib/introspection';
import { ChevronRight, ChevronDown, Search, Box, Zap, Bell } from 'lucide-react';

interface SchemaExplorerProps {
  schema: GraphQLSchema | null;
  onFieldSelect?: (field: string) => void;
}

export default function SchemaExplorer({ schema, onFieldSelect }: SchemaExplorerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());

  if (!schema) {
    return (
      <div className="p-4 text-sm text-muted-foreground text-center">
        No schema loaded. Click "Fetch Schema" to load.
      </div>
    );
  }

  const rootTypes = getRootTypes(schema);
  const objectTypes = getTypesByKind(schema, 'OBJECT').filter(
    t => t.name !== rootTypes.query && t.name !== rootTypes.mutation && t.name !== rootTypes.subscription
  );
  const inputTypes = getTypesByKind(schema, 'INPUT_OBJECT');
  const enumTypes = getTypesByKind(schema, 'ENUM');

  const toggleType = (typeName: string) => {
    const newExpanded = new Set(expandedTypes);
    if (newExpanded.has(typeName)) {
      newExpanded.delete(typeName);
    } else {
      newExpanded.add(typeName);
    }
    setExpandedTypes(newExpanded);
  };

  const filterBySearch = (name: string) => {
    if (!searchQuery) return true;
    return name.toLowerCase().includes(searchQuery.toLowerCase());
  };

  const TypeItem = ({ typeName, icon: Icon, label }: { typeName: string; icon: React.ElementType; label: string }) => {
    const type = getTypeByName(schema, typeName);
    if (!type) return null;

    const fields = getTypeFields(schema, typeName);
    const isExpanded = expandedTypes.has(typeName);
    const filteredFields = fields.filter(f => filterBySearch(f.name));

    if (searchQuery && filteredFields.length === 0 && !filterBySearch(typeName)) {
      return null;
    }

    return (
      <div className="mb-1">
        <button
          onClick={() => toggleType(typeName)}
          className="flex items-center gap-1 w-full text-left p-1 hover:bg-accent rounded text-sm"
        >
          {isExpanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <Icon className="h-3 w-3 text-primary" />
          <span className="font-medium">{label}</span>
          <span className="text-xs text-muted-foreground ml-1">({filteredFields.length})</span>
        </button>
        {isExpanded && (
          <div className="ml-4 pl-2 border-l border-border">
            {filteredFields.map((field) => (
              <button
                key={field.name}
                onClick={() => onFieldSelect?.(field.name)}
                className="flex items-center justify-between w-full text-left p-1 hover:bg-accent rounded text-xs"
              >
                <span>{field.name}</span>
                <span className="text-muted-foreground">{formatTypeRef(field.type)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const formatTypeRef = (typeRef: any): string => {
    if (!typeRef) return '';
    if (typeRef.kind === 'NON_NULL') return `${formatTypeRef(typeRef.ofType)}!`;
    if (typeRef.kind === 'LIST') return `[${formatTypeRef(typeRef.ofType)}]`;
    return typeRef.name || '';
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search schema..."
            className="pl-7 h-7 text-xs"
          />
        </div>
      </div>
      <ScrollArea className="flex-1 p-2">
        {/* Root Operations */}
        {rootTypes.query && (
          <TypeItem typeName={rootTypes.query} icon={Box} label="Query" />
        )}
        {rootTypes.mutation && (
          <TypeItem typeName={rootTypes.mutation} icon={Zap} label="Mutation" />
        )}
        {rootTypes.subscription && (
          <TypeItem typeName={rootTypes.subscription} icon={Bell} label="Subscription" />
        )}

        {/* Types */}
        {objectTypes.length > 0 && (
          <div className="mt-3">
            <div className="text-xs font-medium text-muted-foreground mb-1 px-1">Types</div>
            {objectTypes.filter(t => t.name && filterBySearch(t.name)).map((type) => (
              <TypeItem key={type.name} typeName={type.name!} icon={Box} label={type.name!} />
            ))}
          </div>
        )}

        {/* Inputs */}
        {inputTypes.length > 0 && (
          <div className="mt-3">
            <div className="text-xs font-medium text-muted-foreground mb-1 px-1">Inputs</div>
            {inputTypes.filter(t => t.name && filterBySearch(t.name)).map((type) => (
              <TypeItem key={type.name} typeName={type.name!} icon={Box} label={type.name!} />
            ))}
          </div>
        )}

        {/* Enums */}
        {enumTypes.length > 0 && (
          <div className="mt-3">
            <div className="text-xs font-medium text-muted-foreground mb-1 px-1">Enums</div>
            {enumTypes.filter(t => t.name && filterBySearch(t.name)).map((type) => (
              <div key={type.name} className="text-xs p-1 hover:bg-accent rounded">
                {type.name}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
