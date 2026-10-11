/**
 * Single source of truth for the site's <title>, meta description, and Open Graph defaults.
 * Per-page overrides go through the `<Seo />` component or the `seo` prop on `<Page />`.
 * Keep `siteName` in sync with the static <title> fallback in `src/client/index.html`.
 */

export interface SeoConfig {
  siteName: string;
  /** Site-wide default meta description (70-160 characters of plain prose). */
  description: string;
  /** Renders the final <title>. Receives the per-page title (if any). */
  formatTitle: (title?: string) => string;
}

const siteName = 'MongoMation';

const description =
  'Describe the machine. We engineer the control system. The harness gets smarter. Live IEC 61131-3 engineering runs from MongoDB Atlas.';

export const seoConfig: SeoConfig = {
  siteName,
  description,
  formatTitle: (title) => (title ? `${title} · ${siteName}` : siteName),
};
