import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import AuthConfigComponent from '@/features/auth/components/AuthConfig';
import { loadContractSpec } from '@/features/contracts/lib/specLoader';
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
 *  - folder     → Auth · Scripts (contracts are collection-scoped)
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
  const [saving, setSaving] = useState(false);

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

  const handleSave = async () => {
    if (target.scope === 'collection') {
      const normalizedKeys = variables.map((variable) => variable.key.trim());
      if (normalizedKeys.some((key) => key.length === 0)) {
        toast.error('Collection variables must have a name');
        return;
      }
      if (new Set(normalizedKeys).size !== normalizedKeys.length) {
        toast.error('Collection variable names must be unique');
        return;
      }
      const contractSpec = buildContractSpec();
      if (contractSource !== 'none' && !contractSpec) {
        toast.error('Complete the contract source before saving');
        return;
      }
      if (contractSpec) {
        setSaving(true);
        const validation = await loadContractSpec(contractSpec);
        setSaving(false);
        if (!validation.ok) {
          toast.error('Contract could not be loaded', { description: validation.error });
          return;
        }
      }
    }

    // `auth: {type:'none'}` is stored as undefined so it never masks an
    // ancestor's auth in inheritance walks (see isConfiguredAuth).
    const common = {
      auth: auth.type !== 'none' ? auth : undefined,
      preRequestScript: preRequestScript.trim() ? preRequestScript : undefined,
      testScript: testScript.trim() ? testScript : undefined,
    };
    if (target.scope === 'collection') {
      updateCollection(target.collection.id, {
        ...common,
        contractSpec: buildContractSpec(),
        variables: variables.length > 0 ? variables : undefined,
        description: description.trim() ? description : undefined,
      });
    } else {
      updateCollectionItem(target.collectionId, target.item.id, common);
    }
    onClose();
  };

  const isCollection = target.scope === 'collection';
  const legacyFolderContract = target.scope === 'folder' ? target.item.contractSpec : undefined;

  const promoteFolderContract = () => {
    if (target.scope !== 'folder' || !legacyFolderContract) return;
    updateCollection(target.collectionId, { contractSpec: legacyFolderContract });
    updateCollectionItem(target.collectionId, target.item.id, { contractSpec: undefined });
    toast.success('Folder contract promoted to the collection');
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader icon={SlidersHorizontal}>
          <DialogTitle>
            {isCollection ? 'Collection settings' : 'Folder settings'} — {name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Configure default auth, scripts, and contract spec
            {isCollection ? ', variables, and documentation' : ''} for {name}.
          </DialogDescription>
        </DialogHeader>

        {legacyFolderContract && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <p className="text-muted-foreground">
              This folder contains a legacy contract attachment. Contracts are now configured at
              collection scope.
            </p>
            <Button className="mt-2" size="sm" variant="outline" onClick={promoteFolderContract}>
              Promote to collection
            </Button>
          </div>
        )}

        <Tabs defaultValue="auth" className="flex-1 min-h-0 flex flex-col">
          <TabsList>
            <TabsTrigger value="auth">Auth</TabsTrigger>
            {isCollection && <TabsTrigger value="variables">Variables</TabsTrigger>}
            <TabsTrigger value="scripts">Scripts</TabsTrigger>
            {isCollection && <TabsTrigger value="docs">Docs</TabsTrigger>}
            {isCollection && <TabsTrigger value="contract">Contract</TabsTrigger>}
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

            {isCollection && (
              <TabsContent value="contract" className="mt-0 space-y-3">
                <p className="text-xs text-muted-foreground">
                  Attach an OpenAPI spec — used to generate mock server routes. Execution-time
                  response validation against the spec is not wired up yet.
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
            )}
          </div>
        </Tabs>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Validating…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
