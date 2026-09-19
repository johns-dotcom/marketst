// Registry of NDA templates surfaced on the /create-nda page.
//
// To add a new template:
//   1. Copy standard.js to <yourid>.js, tweak the metadata (id, label,
//      description, defaults, extraFields, optionalClauses) and rewrite
//      buildBody(form) to emit the new template's text.
//   2. Import the new template here and add it to the exported list.
//   3. That's it — the /create-nda page picks it up automatically:
//      the tab strip renders it, /create-nda/<yourid> becomes a valid
//      subpage, and saved NDAs remember their template via the
//      template_id column on boom_ndas.
//
// The FIRST template in the list is the default landing template when
// a user navigates to /create-nda with no id in the URL — keep the
// most-used template first.

import standard from './standard'
import invest from './invest'

export const NDA_TEMPLATES = [
  standard,
  invest,
]

// Keyed lookup for the loader ("what template did this saved NDA use?")
// and the router param resolver.
export const TEMPLATES_BY_ID = Object.fromEntries(
  NDA_TEMPLATES.map(t => [t.id, t])
)

// Safe accessor — returns the requested template or falls back to the
// first template in the registry when the id is unknown (URL typo,
// deleted template, etc.) so the page never lands on a blank state.
export function getTemplate(id) {
  return TEMPLATES_BY_ID[id] || NDA_TEMPLATES[0]
}

// Re-export shared helpers so consumers can import everything from
// './nda-templates' as one namespace.
export { BOOM_DEFAULTS, applyLabelDefaults, ROMAN, formatEffectiveDate, escapeRegex, getHeadingLevel, BASE_FIELDS, BASE_BODY_FIELDS, defaultRenderSignature } from './shared'

// Convenience — returns the template's own renderSignature when it
// declared one, otherwise the shared default. Consumers should always
// go through this so signature-block rendering is uniform.
import { defaultRenderSignature as _defRS } from './shared'
export function renderSignatureFor(template, form) {
  return (template && typeof template.renderSignature === 'function')
    ? template.renderSignature(form)
    : _defRS(form)
}
