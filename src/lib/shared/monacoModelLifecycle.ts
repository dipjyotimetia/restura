import type * as Monaco from 'monaco-editor';

/**
 * Models retained by @monaco-editor/react must be explicitly released when
 * their owning workspace tab closes. Keeping this registry separate from the
 * editor setup avoids pulling Monaco into the eager request store bundle.
 */
const retainedModelsByOwner = new Map<string, Map<string, Monaco.editor.ITextModel>>();

export function retainMonacoModel(
  owner: string,
  path: string,
  model: Monaco.editor.ITextModel
): void {
  let models = retainedModelsByOwner.get(owner);
  if (!models) {
    models = new Map();
    retainedModelsByOwner.set(owner, models);
  }

  const previous = models.get(path);
  if (previous && previous !== model) previous.dispose();
  models.set(path, model);
}

export function disposeRetainedMonacoModelsForOwner(owner: string): void {
  const models = retainedModelsByOwner.get(owner);
  if (!models) return;
  retainedModelsByOwner.delete(owner);
  for (const model of models.values()) model.dispose();
}
