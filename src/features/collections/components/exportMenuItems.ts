/**
 * The collection Export submenu (#1229), kept out of `SidebarCollectionsPanel`
 * so it can be tested without rendering the sidebar.
 */

export type ExportFormat = 'postman-v3' | 'postman-v21' | 'insomnia' | 'opencollection' | 'bruno';

/** Export submenu, in display order: Postman v3 is the default (#1229). */
export const EXPORT_MENU_ITEMS: ReadonlyArray<{ format: ExportFormat; label: string }> = [
  { format: 'postman-v3', label: 'Postman v3 (folder / zip)' },
  { format: 'postman-v21', label: 'Postman v2.1 (single file · Newman)' },
  { format: 'insomnia', label: 'Insomnia Collection' },
  { format: 'opencollection', label: 'OpenCollection (YAML)' },
  { format: 'bruno', label: 'Bruno (.bru archive)' },
];
