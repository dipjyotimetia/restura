import { useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import AuthConfigComponent from '@/features/auth/components/AuthConfig';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import ScriptsEditor from '@/features/scripts/components/ScriptsEditor';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { AuthConfig, Collection, CollectionItem, ContractSpecSource, KeyValue } from '@/types';

/**
 * Settings dialog for a collection or a folder. Until this existed, the
 * data-model fields the runner already consumes — collection variables,
 * collection/folder-level scripts, description, contract spec, folder auth —
 * were import-only: a Postman import populated them but nothing in the UI
 * could view or edit them.
 *
 * Scope differences:
 *  - collection → Auth · Variables · Scripts · Docs · Contract
 *  - folder     → Auth · Scripts · Contract (folders have no variables/description)
 */

export type SettingsTarget =
  | { scope: 'collection'; collection: Collection }
  | { scope: 'folder'; collectionId: string; item: CollectionItem };

interface Props {
  target: SettingsTarget | null;
  onClose: () => void;
}

type ContractSource = 'none' | ContractSpecSource['source'];

export function CollectionSettingsDialog({ target, onClose }: Props) {
  const updateCollection = useCollectionStore((s) => s.updateCollection);
  const updateCollectionItem = useCollectionStore((s) => s.updateCollectionItem);

  const [auth, setAuth] = useState<AuthConfig>({ type: 'none' });
  const [variables, setVariables] = useState<KeyValue[]>([]);
  const [preRequestScript, setPreRequestScript] = useState('');
  const [testScript, setTestScript] = useState('');
  const [description, setDescription] = useState('');
  const [contractSource, setContractSource] = useState<ContractSource>('none');
  const [contractUrl, setContractUrl] = useState('');
  const [contractInline, setContractInline] = useState('');

  // Re-seed drafts whenever the dialog opens on a new target.
  const targetId = target?.scope === 'collection' ? target.collection.id : target?.item.id;
  useEffect(() => {
    if (!target) return;
    const source = target.scope === 'collection' ? target.collection : target.item;
    setAuth(source.auth ?? { type: 'none' });
    setPreRequestScript(source.preRequestScript ?? '');
    setTestScript(source.testScript ?? '');
    setContractSource(source.contractSpec?.source ?? 'none');
    setContractUrl(source.contractSpec?.url ?? '');
    setContractInline(source.contractSpec?.inline ?? '');
    if (target.scope === 'collection') {
      setVariables(target.collection.variables ?? []);
      setDescription(target.collection.description ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed on open/target change only
  }, [targetId]);

  if (!target) return null;

  const name = target.scope === 'collection' ? target.collection.name : target.item.name;

  const buildContractSpec = (): ContractSpecSource | undefined => {
    if (contractSource === 'url' && contractUrl.trim()) {
      return { kind: 'openapi', source: 'url', url: contractUrl.trim() };
    }
    if (contractSource === 'inline' && contractInline.trim()) {
      return { kind: 'openapi', source: 'inline', inline: contractInline };
    }
    return undefined;
  };

  const handleSave = () => {
    // `auth: {type:'none'}` is stored as undefined so it never masks an
    // ancestor's auth in inheritance walks (see isConfiguredAuth).
    const common = {
      auth: auth.type !== 'none' ? auth : undefined,
      preRequestScript: preRequestScript.trim() ? preRequestScript : undefined,
      testScript: testScript.trim() ? testScript : undefined,
      contractSpec: buildContractSpec(),
    };
    if (target.scope === 'collection') {
      updateCollection(target.collection.id, {
        ...common,
        variables: variables.length > 0 ? variables : undefined,
        description: description.trim() ? description : undefined,
      });
    } else {
      updateCollectionItem(target.collectionId, target.item.id, common);
    }
    onClose();
  };

  const isCollection = target.scope === 'collection';

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {isCollection ? 'Collection settings' : 'Folder settings'} — {name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Configure default auth, scripts, and contract spec
            {isCollection ? ', variables, and documentation' : ''} for {name}.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="auth" className="flex-1 min-h-0 flex flex-col">
          <TabsList>
            <TabsTrigger value="auth">Auth</TabsTrigger>
            {isCollection && <TabsTrigger value="variables">Variables</TabsTrigger>}
            <TabsTrigger value="scripts">Scripts</TabsTrigger>
            {isCollection && <TabsTrigger value="docs">Docs</TabsTrigger>}
            <TabsTrigger value="contract">Contract</TabsTrigger>
          </TabsList>

          <div className="flex-1 min-h-0 overflow-y-auto py-3">
            <TabsContent value="auth" className="mt-0 space-y-2">
              <p className="text-xs text-muted-foreground">
                {isCollection
                  ? 'Default auth for every request in this collection that has no auth of its own.'
                  : 'Default auth for requests in this folder (overrides the collection default; nearest folder wins).'}
              </p>
              <AuthConfigComponent auth={auth} onChange={setAuth} />
            </TabsContent>

            {isCollection && (
              <TabsContent value="variables" className="mt-0 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Collection variables are available as {'{{name}}'} in every request of this
                  collection and are merged under the active environment.
                </p>
                <KeyValueEditor
                  items={variables}
                  onAdd={() =>
                    setVariables((prev) => [
                      ...prev,
                      { id: uuidv4(), key: '', value: '', enabled: true },
                    ])
                  }
                  onUpdate={(id, updates) =>
                    setVariables((prev) =>
                      prev.map((v) => (v.id === id ? { ...v, ...updates } : v))
                    )
                  }
                  onDelete={(id) => setVariables((prev) => prev.filter((v) => v.id !== id))}
                  keyPlaceholder="variable"
                  valuePlaceholder="value"
                  addButtonText="Add variable"
                  itemType="variable"
                />
              </TabsContent>
            )}

            <TabsContent value="scripts" className="mt-0 space-y-2">
              <p className="text-xs text-muted-foreground">
                {isCollection
                  ? 'Run for every request in a collection run, before folder- and request-level scripts.'
                  : 'Run for every descendant request in a collection run, after collection-level scripts.'}
              </p>
              <ScriptsEditor
                preRequestScript={preRequestScript}
                testScript={testScript}
                onPreRequestScriptChange={setPreRequestScript}
                onTestScriptChange={setTestScript}
              />
            </TabsContent>

            {isCollection && (
              <TabsContent value="docs" className="mt-0 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Markdown description — shown in the generated API docs.
                </p>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What does this API do?"
                  className="min-h-[200px] font-mono text-xs"
                />
              </TabsContent>
            )}

            <TabsContent value="contract" className="mt-0 space-y-3">
              <p className="text-xs text-muted-foreground">
                Attach an OpenAPI spec; requests with a contract reference are validated against it
                at execution time.{!isCollection && ' Overrides the collection-level spec.'}
              </p>
              <Select
                value={contractSource}
                onValueChange={(v) => setContractSource(v as ContractSource)}
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No contract</SelectItem>
                  <SelectItem value="url">From URL</SelectItem>
                  <SelectItem value="inline">Inline (paste)</SelectItem>
                </SelectContent>
              </Select>
              {contractSource === 'url' && (
                <Input
                  value={contractUrl}
                  onChange={(e) => setContractUrl(e.target.value)}
                  placeholder="https://example.com/openapi.yaml"
                  className="font-mono text-xs"
                />
              )}
              {contractSource === 'inline' && (
                <Textarea
                  value={contractInline}
                  onChange={(e) => setContractInline(e.target.value)}
                  placeholder="Paste OpenAPI YAML or JSON…"
                  className="min-h-[200px] font-mono text-xs"
                />
              )}
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
