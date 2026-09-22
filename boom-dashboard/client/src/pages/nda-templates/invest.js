// Invest NDA — the confidentiality template market.st executes
// with corporate counterparties evaluating a potential investment or
// transaction. Structured to match the same clause set the "Range
// Music v2" template introduced, but shipped as a blank template so
// every submission fills in its own counterparty details rather than
// autofilling any one investor. Differs from `standard` in the body:
//   • Preamble introduces the "Purpose" concept (evaluate, negotiate,
//     consummate a transaction).
//   • Section II expands the confidentiality scope to cover "Personnel"
//     (directors, officers, managers, employees, contractors, agents,
//     advisers, lenders, members, affiliates) and adds a Section II(E)
//     Disclosure to Government Entities carve-out.
//   • Section IV allows retention of Confidential Information to
//     comply with law / internal policy / auto-archive; extends the
//     certification window to 10 business days.
//   • Section V adds no-obligation-to-enter-further-agreements
//     language + right to refuse further Confidential Information.
//   • Section VIII (Other Businesses) — new; acknowledges the
//     Recipient may be engaged in competing businesses.
//   • Sections IX and XII intentionally omitted (placeholders that
//     preserve the original numbering scheme).
//   • Term is one year (not two); Sections IV, V, VII–XI survive
//     indefinitely.
//   • No Non-Circumvention, Non-Solicitation, Indemnity, Attorney's
//     Fees, or Whistleblower Protection sections.
//   • Signature block: two extra fields let the operator declare
//     the individual signing on behalf of the corporate recipient
//     (name + title). Nothing is prefilled.

import { ROMAN, formatEffectiveDate, BASE_BODY_FIELDS, defaultRenderSignature } from './shared'

// Body-participating fields — extras that appear directly in the
// body text and should be watched by the dirty-mode diff. The
// signature-block extras don't appear in the body itself (they're
// rendered in the separate signature block below the body), so we
// don't add them here.
const INVEST_BODY_FIELDS = BASE_BODY_FIELDS

function buildBody(form) {
  const owner = form.owner_name || 'OWNER'
  const ownerAddr = form.owner_address || ''
  const recipient = form.recipient_name || 'RECIPIENT'
  const recipientAddr = form.recipient_address || ''
  const effective = formatEffectiveDate(form.effective_date) || '____________'
  const signatoryName = form.signatory_name || '___name____'
  const signatoryTitle = form.signatory_title || '__position___'

  // Preamble — no section numbers.
  const preamble = [
    'NON-DISCLOSURE AGREEMENT',
    `This Non-disclosure Agreement (this "Agreement") is made effective as of ${effective} (the "Effective Date"), by and between ${owner} (the "Owner"), of ${ownerAddr} and ${recipient} (the "Recipient"), located at ${recipientAddr}.`,
    `Certain Confidenital Information (as defined below) may be disclosed to the Recipient so that the Recipient may evaluate, negotiate or consummate a potential transaction with the Owner (the "Purpose").`,
    'The Owner has requested and the Recipient agrees that the Recipient will protect the Confidential Information which may be disclosed between the Owner and the Recipient. Therefore, the parties agree as follows:',
  ]

  // Numbered sections. `explicitRoman` overrides the auto-assigned
  // Roman numeral — used for the two "[intentionally omitted.]"
  // placeholders (IX and XII) which sit at fixed positions in the
  // template's numbering scheme.
  const sections = [
    { roman: 'I', title: 'CONFIDENTIAL INFORMATION.', paragraphs: [
      'The term "Confidential Information" means any information or material which is proprietary to the Owner, whether or not owned or developed by the Owner, which is not generally known other than by the Owner, and which the Recipient may obtain through any direct contact with the Owner. Regardless of whether specifically identified as confidential or proprietary, Confidential Information shall include any information provided by the Owner concerning the business, technology and information of the Owner and any third party with which the Owner deals, including, without limitation, business records and plans, trade secrets, technical data, product ideas, contracts, financial information, pricing structure, discounts, computer programs and listings, source code and/or object code, copyrights and intellectual property, inventions, sales leads, strategic alliances, partners, and customer and client lists. The nature of the information and the manner of disclosure are such that a reasonable person would understand it to be confidential.',
      'A. "Confidential Information" does not include:',
      // Bulleted list — rendered as a single paragraph with newlines
      // so the on-screen preview + PDF keep each item on its own line
      // (getHeadingLevel treats it as body text).
      '- matters of public knowledge;\n- information received by the Recipient from a third party not known to owe a duty of confidentiality to the Owner;\n- information independently developed by the Recipient;\n- information disclosed by operation of law;\n- information disclosed by the Recipient with the prior written consent of the Owner; including bank statements, invoices, and any financial documents.\n- and any other information that both parties agree in writing is not confidential.',
    ]},
    { roman: 'II', title: 'PROTECTION OF CONFIDENTIAL INFORMATION.', paragraphs: [
      'The Recipient understands and acknowledges that the Confidential Information has been developed or obtained by the Owner by the investment of significant time, effort and expense, and that the Confidential Information is a valuable, special and unique asset of the Owner which provides the Owner with a significant competitive advantage, and needs to be protected from improper disclosure. In consideration for the receipt by the Recipient of the Confidential Information, the Recipient agrees as follows:',
      'A. No Disclosure.',
      'Except as permitted under this Agreement, the Recipient will hold the Confidential Information in confidence and will not disclose the Confidential Information to any person or entity without the prior written consent of the Owner.',
      'B. No Copying/Modifying.',
      'The Recipient will not copy or modify any Confidential Information without the prior written consent of the Owner.',
      'C. Unauthorized Use.',
      'The Recipient shall promptly advise the Owner if the Recipient becomes aware of any possible unauthorized disclosure or use of the Confidential Information by the Recipient or its Personnel (as defined below).',
      'D. Application to Personnel.',
      'The Recipient shall not disclose any Confidential Information to any third party, except its directors, officers, managers, employees, contractors, agents, legal and financial advisers, lenders, members, and affiliates (collectively, "Personnel") who are required to have the Confidential Information in order to evaluate, negotiate or consummate the Purpose. Each permitted Personnel to whom Confidential Information is disclosed shall have obligations of confidentiality to the Recipient consistent with those contained in this Agreement.',
      'E. Disclosure to Government Entities.',
      'The Recipient and its Personnel may disclose Confidential Information as required to comply with orders of governmental entities that have jurisdiction over it or as otherwise required by law or legal process. If the Recipient is required to disclose Confidential Information as provided in this Section II(E), the Recipient will, to the extent not prohibited by law, provide the Owner with prompt written notice of such requirement and will reasonably cooperate with the Owner (at the Owner\'s sole cost and expense) to protect against or limit the scope of such disclosure. Notwithstanding anything contained in this Agreement to the contrary, the Recipient will not be required to provide the Owner with any such advance notice, or provide the Owner with any opportunity to contest disclosure of any Confidential Information, if such disclosure is in connection with a supervisory examination or audit by, or a blanket request or inquiry from, a regulatory or governmental entity or a securities exchange having jurisdiction over the Recipient or its Personnel, so long as such examination, audit, request or inquiry does not specifically target or relate specifically to the Owner.',
    ]},
    { roman: 'III', title: 'UNAUTHORIZED DISCLOSURE OF INFORMATION - INJUNCTION.', paragraphs: [
      'If it appears that the Recipient has disclosed Confidential Information in breach of this Agreement, the Owner shall be entitled to seek an injunction to restrain the Recipient from disclosing the Confidential Information in whole or in part. The Owner shall not be prohibited by this provision from pursuing other remedies, including a claim for losses and damages.',
    ]},
    { roman: 'IV', title: 'RETURN OF CONFIDENTIAL INFORMATION.', paragraphs: [
      'Upon the written request of the Owner, the Recipient shall promptly return or destroy to the Owner all written materials containing the Confidential Information; provided, however, that the Recipient and its Personnel may retain copies of the Confidential Information to comply with applicable law or regulation or internal policies or as part of automatic electronic archiving and back-up procedures, provided further that such Confidential Information is kept confidential as provided in this Agreement. Upon further written request, the Recipient shall also deliver to the Owner written statements signed by the Recipient certifying that all materials have been returned or destroyed within 10 business days of receipt of the request.',
    ]},
    { roman: 'V', title: 'RELATIONSHIP OF PARTIES.', paragraphs: [
      'Neither party has an obligation under this Agreement to purchase any service or item from the other party, or commercially offer any products using or incorporating the Confidential Information. This Agreement does not create any agency, partnership, or joint venture. Neither party will be under any obligation to enter into any further agreements with the other party of any nature whatsoever as a result of this Agreement. Any party may terminate the evaluation of Confidential Information and any discussions with respect to the Purpose at any time for any reason or no reason. The Recipient will have the right to refuse to accept any Confidential Information under this Agreement.',
    ]},
    { roman: 'VI', title: 'NO WARRANTY.', paragraphs: [
      'The Recipient acknowledges and agrees that the Confidential Information is provided on an "AS IS" basis. EXCEPT AS MAY BE PROVIDED FOR WITHIN A DEFINITIVE AGREEMENT WITH RESPECT TO THE PURPOSE, (1) THE OWNER MAKES NO WARRANTIES, EXPRESS OR IMPLIED, WITH RESPECT TO THE CONFIDENTIAL INFORMATION AND HEREBY EXPRESSLY DISCLAIMS ANY AND ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE; AND (2) IN NO EVENT SHALL THE OWNER BE LIABLE FOR ANY DIRECT, INDIRECT, SPECIAL, OR CONSEQUENTIAL DAMAGES IN CONNECTION WITH OR ARISING OUT OF THE PERFORMANCE OR USE OF ANY PORTION OF THE CONFIDENTIAL INFORMATION.',
    ]},
    { roman: 'VII', title: 'LIMITED LICENSE TO USE.', paragraphs: [
      'The Recipient shall not acquire any intellectual property rights under this Agreement except the limited right to use as set forth above. The Recipient acknowledges that, as between the Owner and the Recipient, the Confidential Information and all related copyrights and other intellectual property rights, are (and at all times will be) the property of the Owner, even if suggestions, comments, and/or ideas made by the Recipient are incorporated into the Confidential Information or related materials during the period of this Agreement.',
    ]},
    { roman: 'VIII', title: 'OTHER BUSINESSES.', paragraphs: [
      'The Owner acknowledges that the Recipient is engaged in businesses that are similar to and competitive with the businesses of the Owner. Nothing in this Agreement shall limit or restrict in any way the Recipient from engaging in such businesses and competing with the Owner from using information and materials that are not Confidential Information in connection with its businesses, even if such information is similar to or duplicative of the Confidential Information. For clarity, nothing shall prevent the Recipient from developing or commercializing new business strategies, as long as such activities do not utilize any Confidential Information in breach of this Agreement. The Owner agrees that its Confidential Information will inevitably enhance and increase the knowledge of the Recipient and its Personnel that actually receive Confidential Information in a way that cannot be forgotten or separated from such persons\' overall knowledge base and, accordingly, neither the Recipient nor its Personnel will be (or be deemed to be) in breach of this Agreement by reason of remembering, retaining and/or using such enhanced or increased knowledge in such persons\' respective businesses.',
    ]},
    // Placeholder — preserves the historical numbering after two
    // clauses were struck. Rendered as a single-line entry.
    { roman: 'IX', title: '[intentionally omitted.]', paragraphs: [] },
    { roman: 'X', title: 'TERM.', paragraphs: [
      'The obligations of this Agreement shall survive until the earlier of (1) one year from the Effective Date or (2) until the Owner sends the Recipient written notice releasing the Recipient from this Agreement; provided, however, that Sections IV, V, VII through XI shall survive indefinitely.',
    ]},
    { roman: 'XI', title: 'GENERAL PROVISIONS.', paragraphs: [
      'This Agreement sets forth the entire understanding of the parties regarding confidentiality. Any amendments must be in writing and signed by both parties. This Agreement shall be construed under the laws of the State of California. This Agreement shall not be assignable by either party. Neither party may delegate its duties under this Agreement without the prior written consent of the other party. The confidentiality provisions of this Agreement shall remain in full force and effect at all times in accordance with the term of this Agreement. If any provision of this Agreement is held to be invalid, illegal or unenforceable, the remaining portions of this Agreement shall remain in full force and effect and construed so as to best effectuate the original intent and purpose of this Agreement.',
    ]},
    { roman: 'XII', title: '[intentionally omitted.]', paragraphs: [] },
    { roman: 'XIII', title: 'SIGNATORIES.', paragraphs: [
      `This Agreement shall be executed by ${signatoryName}, ${signatoryTitle}, on behalf of the Owner and the Recipient and delivered in the manner prescribed by law as of the date first written above.`,
    ]},
  ]

  const out = [...preamble]
  for (const s of sections) {
    // Range uses explicit Roman numerals throughout so the two
    // [intentionally omitted.] placeholders keep their positions in
    // the sequence — no auto-renumbering.
    const num = s.roman || ROMAN[out.length]
    out.push(`${num}. ${s.title}`)
    for (const p of s.paragraphs) out.push(p)
  }
  return out.join('\n\n')
}

const invest = {
  id: 'invest',
  label: 'Invest',
  description: 'Confidentiality NDA for corporate counterparties evaluating a potential investment or transaction with market.st. Shipped blank — no counterparty details pre-filled.',
  // Filename matches the standard template's — the tab label is
  // internal-only; the counterparty receives a doc named just NDA.
  filenamePrefix: 'NDA',
  // Extra form fields beyond the shared base. The template supports
  // a separate individual signing on behalf of the recipient entity
  // (name + title). Left blank so every submission fills in the
  // specific investor.
  extraFields: [
    {
      key: 'recipient_signatory_name',
      label: 'Recipient Signatory Name',
      type: 'text',
      required: false,
      description: 'The individual signing on behalf of the recipient entity.',
    },
    {
      key: 'recipient_signatory_title',
      label: 'Recipient Signatory Title',
      type: 'text',
      required: false,
    },
  ],
  // No optional clauses on this template — every section listed above
  // is mandatory.
  optionalClauses: [],
  // No defaults — the operator fills in owner signatory + recipient
  // per submission. Base BLANK_FORM still supplies BOOM_DEFAULTS on
  // the Owner side (name, address, signatory), so only the Recipient
  // side and the extras start truly blank.
  defaults: {},
  // Mandatory-section checks — the "missing sections" warning fires
  // when a loaded body no longer contains any of these markers.
  mandatorySections: [
    { name: 'PROTECTION OF CONFIDENTIAL INFORMATION', test: /PROTECTION OF CONFIDENTIAL INFORMATION/ },
    { name: 'OTHER BUSINESSES',                       test: /OTHER BUSINESSES/                       },
    { name: 'SIGNATORIES',                            test: /\bSIGNATORIES\./                        },
  ],
  bodyFields: INVEST_BODY_FIELDS,
  // Signature block — uses the shared default which already inspects
  // recipient_signatory_name / recipient_signatory_title. The extras
  // above supply the values.
  renderSignature: defaultRenderSignature,
  buildBody,
}

export default invest
