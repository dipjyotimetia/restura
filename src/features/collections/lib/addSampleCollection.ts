import { toast } from 'sonner';
import { useCollectionStore } from '@/store/useCollectionStore';
import { buildSampleCollection } from './sampleCollection';

/** Add the echo-server sample collection (opt-in from the empty states). */
export function addSampleCollection(): void {
  const collection = buildSampleCollection();
  useCollectionStore.getState().addCollection(collection);
  toast.success('Sample collection added', {
    description: 'Open a request in the sidebar and press Send.',
  });
}
