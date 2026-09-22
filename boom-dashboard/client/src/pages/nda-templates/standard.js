// Standard NDA — the historical market.st mutual-confidentiality
// template with optional Non-Circumvention (1-year) and Non-Solicitation
// (2-year) sections. This is the ONLY template that existed before the
// registry refactor; anything created before the refactor rolls forward
// as `template_id = 'standard'` automatically.
//
// To add a new NDA template: copy this file, tweak the metadata below
// (id, label, description, defaults, extraFields, optionalClauses),
// rewrite `buildBody`, and register it in ./index.js.

import { BOOM_DEFAULTS, ROMAN, formatEffectiveDate, BASE_BODY_FIELDS } from './shared'

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
    `Information will be disclosed to ${recipient} to determine whether ${recipient} could assist ${owner} with the development of artists, marketing plans, business development and overall company strategy.`,
    'The Owner has requested and the Recipient agrees that the Recipient will protect the confidential material and information which may be disclosed between the Owner and the Recipient. Therefore, the parties agree as follows:',
  ]

  // Numbered sections. `optional` (when set) maps to a form boolean that
  // gates inclusion — false on the form omits the whole block. The Roman
  // numeral is prepended at render time so removing an optional section
  // doesn't leave a gap in the sequence.
  const sections = [
    { title: 'CONFIDENTIAL INFORMATION.', paragraphs: [
      'The term "Confidential Information" means any information or material which is proprietary to the Owner, whether or not owned or developed by the Owner, which is not generally known other than by the Owner, and which the Recipient may obtain through any direct or indirect contact with the Owner. Regardless of whether specifically identified as confidential or proprietary, Confidential Information shall include any information provided by the Owner concerning the business, technology and information of the Owner and any third party with which the Owner deals, including, without limitation, business records and plans, trade secrets, technical data, product ideas, contracts, financial information, pricing structure, discounts, computer programs and listings, source code and/or object code, copyrights and intellectual property, inventions, sales leads, strategic alliances, partners, and customer and client lists. The nature of the information and the manner of disclosure are such that a reasonable person would understand it to be confidential.',
      'A. "Confidential Information" does not include:',
      '- matters of public knowledge that result from disclosure by the Owner;\n- information rightfully received by the Recipient from a third party without a duty of confidentiality;\n- information independently developed by the Recipient;\n- information disclosed by operation of law;\n- information disclosed by the Recipient with the prior written consent of the Owner; including bank statements, invoices, and any financial documents.\n- and any other information that both parties agree in writing is not confidential.',
    ]},
    { title: 'PROTECTION OF CONFIDENTIAL INFORMATION.', paragraphs: [
      'The Recipient understands and acknowledges that the Confidential Information has been developed or obtained by the Owner by the investment of significant time, effort and expense, and that the Confidential Information is a valuable, special and unique asset of the Owner which provides the Owner with a significant competitive advantage, and needs to be protected from improper disclosure. In consideration for the receipt by the Recipient of the Confidential Information, the Recipient agrees as follows:',
      'A. No Disclosure.',
      'The Recipient will hold the Confidential Information in confidence and will not disclose the Confidential Information to any person or entity without the prior written consent of the Owner.',
      'B. No Copying/Modifying.',
      'The Recipient will not copy or modify any Confidential Information without the prior written consent of the Owner.',
      'C. Unauthorized Use.',
      'The Recipient shall promptly advise the Owner if the Recipient becomes aware of any possible unauthorized disclosure or use of the Confidential Information.',
      'D. Application to Employees.',
      'The Recipient shall not disclose any Confidential Information to any employees of the Recipient, except those employees who are required to have the Confidential Information in order to perform their job duties in connection with the limited purposes of this Agreement. Each permitted employee to whom Confidential Information is disclosed shall sign a non-disclosure agreement substantially the same as this Agreement at the request of the Owner.',
    ]},
    { title: 'UNAUTHORIZED DISCLOSURE OF INFORMATION - INJUNCTION.', paragraphs: [
      'If it appears that the Recipient has disclosed (or has threatened to disclose) Confidential Information in violation of this Agreement, the Owner shall be entitled to an injunction to restrain the Recipient from disclosing the Confidential Information in whole or in part. The Owner shall not be prohibited by this provision from pursuing other remedies, including a claim for losses and damages.',
    ]},
    { title: 'NON-CIRCUMVENTION.', optional: 'include_non_circumvention', paragraphs: [
      'For a period of One (1) years after the end of the term of this Agreement, the Recipient will not attempt to do business with, or otherwise solicit any business contacts found or otherwise referred by Owner to Recipient for the purpose of circumventing, the result of which shall be to prevent the Owner from realizing or recognizing a profit, fees, or otherwise, without the specific written approval of the Owner. If such circumvention shall occur the Owner shall be entitled to any commissions due pursuant to this Agreement or relating to such transaction.',
    ]},
    { title: 'NON-SOLICITATION.', optional: 'include_non_solicitation', paragraphs: [
      'For a period of two (2) years after the expiration or termination of this Agreement, the Recipient shall not, directly or indirectly:',
      'A. Non-Solicitation of Employees.',
      'Solicit, recruit, hire, or attempt to solicit or hire any employee, contractor, or consultant of the Owner who was introduced to or became known to the Recipient in connection with this Agreement, without the prior written consent of the Owner.',
      'B. Non-Solicitation of Clients and Business Relationships.',
      'Solicit, contact, or attempt to do business with any client, customer, vendor, partner, or other business contact of the Owner that was introduced to or became known to the Recipient through or in connection with this Agreement, for the purpose of providing services or products competitive with or similar to those offered by the Owner.',
      'C. Non-Solicitation of Artists and Talent.',
      'Solicit, recruit, sign, or attempt to solicit any artist, performer, or talent managed, represented, or developed by the Owner that was introduced to or became known to the Recipient in connection with this Agreement, without the prior written consent of the Owner.',
      'D. Remedies.',
      'The Recipient acknowledges that any breach or threatened breach of this Section would cause irreparable harm to the Owner for which monetary damages would be an inadequate remedy, and the Owner shall be entitled to seek injunctive relief in addition to any other remedies available at law or in equity.',
    ]},
    { title: 'RETURN OF CONFIDENTIAL INFORMATION.', paragraphs: [
      'Upon the written request of the Owner, the Recipient shall return to the Owner all written materials containing the Confidential Information. The Recipient shall also deliver to the Owner written statements signed by the Recipient certifying that all materials have been returned within five (5) days of receipt of the request.',
    ]},
    { title: 'RELATIONSHIP OF PARTIES.', paragraphs: [
      'Neither party has an obligation under this Agreement to purchase any service or item from the other party, or commercially offer any products using or incorporating the Confidential Information. This Agreement does not create any agency, partnership, or joint venture.',
    ]},
    { title: 'NO WARRANTY.', paragraphs: [
      'The Recipient acknowledges and agrees that the Confidential Information is provided on an "AS IS" basis. THE OWNER MAKES NO WARRANTIES, EXPRESS OR IMPLIED, WITH RESPECT TO THE CONFIDENTIAL INFORMATION AND HEREBY EXPRESSLY DISCLAIMS ANY AND ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE. IN NO EVENT SHALL THE OWNER BE LIABLE FOR ANY DIRECT, INDIRECT, SPECIAL, OR CONSEQUENTIAL DAMAGES IN CONNECTION WITH OR ARISING OUT OF THE PERFORMANCE OR USE OF ANY PORTION OF THE CONFIDENTIAL INFORMATION. The Owner does not represent or warrant that any product or business plans disclosed to the Recipient will be marketed or carried out as disclosed, or at all. Any actions taken by the Recipient in response to the disclosure of the Confidential Information shall be solely at the risk of the Recipient.',
    ]},
    { title: 'LIMITED LICENSE TO USE.', paragraphs: [
      'The Recipient shall not acquire any intellectual property rights under this Agreement except the limited right to use as set forth above. The Recipient acknowledges that, as between the Owner and the Recipient, the Confidential Information and all related copyrights and other intellectual property rights, are (and at all times will be) the property of the Owner, even if suggestions, comments, and/or ideas made by the Recipient are incorporated into the Confidential Information or related materials during the period of this Agreement.',
    ]},
    { title: 'INDEMNITY.', paragraphs: [
      'Each party agrees to defend, indemnify, and hold harmless the other party and its officers, directors, agents, affiliates, distributors, representatives, and employees from any and all third party claims, demands, liabilities, costs and expenses, including reasonable attorney’s fees, costs and expenses resulting from the indemnifying party’s material breach of any duty, representation, or warranty under this Agreement.',
    ]},
    { title: 'ATTORNEY’S FEES.', paragraphs: [
      'In any legal action between the parties concerning this Agreement, the prevailing party shall be entitled to recover reasonable attorney’s fees and costs.',
    ]},
    { title: 'TERM.', paragraphs: [
      'The obligations of this Agreement shall survive 2 Years from the Effective Date or until the Owner sends the Recipient written notice releasing the Recipient from this Agreement. After that, the Recipient must continue to protect the Confidential Information that was received during the term of this Agreement from unauthorized use or disclosure for an additional 2 years.',
    ]},
    { title: 'GENERAL PROVISIONS.', paragraphs: [
      'This Agreement sets forth the entire understanding of the parties regarding confidentiality. Any amendments must be in writing and signed by both parties. This Agreement shall be construed under the laws of the State of California. This Agreement shall not be assignable by either party. Neither party may delegate its duties under this Agreement without the prior written consent of the other party. The confidentiality provisions of this Agreement shall remain in full force and effect at all times in accordance with the term of this Agreement. If any provision of this Agreement is held to be invalid, illegal or unenforceable, the remaining portions of this Agreement shall remain in full force and effect and construed so as to best effectuate the original intent and purpose of this Agreement.',
    ]},
    { title: 'WHISTLEBLOWER PROTECTION.', paragraphs: [
      'This Agreement is in compliance with the Defend Trade Secrets Act and provides civil or criminal immunity to any individual for the disclosure of trade secrets: (i) made in confidence to a federal, state, or local government official, or to an attorney when the disclosure is to report suspected violations of the law; or (ii) in a complaint or other document filed in a lawsuit if made under seal.',
    ]},
    { title: 'SIGNATORIES.', paragraphs: [
      `This Agreement shall be executed by ${signatoryName}, ${signatoryTitle}, on behalf of ${owner} and ${recipient} and delivered in the manner prescribed by law as of the date first written above.`,
    ]},
  ]

  const out = [...preamble]
  let i = 0
  for (const s of sections) {
    // `=== false` (not `!form[k]`) so legacy NDAs whose flag column is
    // null/undefined still render the section — matches the historical
    // template.
    if (s.optional && form[s.optional] === false) continue
    out.push(`${ROMAN[i]}. ${s.title}`)
    out.push(...s.paragraphs)
    i++
  }
  return out.join('\n\n')
}

const standard = {
  id: 'standard',
  label: 'Standard NDA',
  description: 'market.st default mutual-confidentiality NDA. Optional non-circumvention and non-solicitation clauses.',
  filenamePrefix: 'NDA',
  // Fields beyond the shared base set (owner, recipient, dates,
  // signatory). Standard has none.
  extraFields: [],
  // Optional clause checkboxes. Each `marker` is the regex the loader
  // uses to detect whether a SAVED body still contains that clause.
  optionalClauses: [
    {
      key: 'include_non_circumvention',
      label: 'Include Non-Circumvention',
      description: '1-year restriction on doing business with Owner\'s contacts.',
      marker: /NON-CIRCUMVENTION/,
    },
    {
      key: 'include_non_solicitation',
      label: 'Include Non-Solicitation',
      description: '2-year restriction on soliciting employees, clients, and artists.',
      marker: /NON-SOLICITATION/,
    },
  ],
  // Form defaults specific to this template — merged onto the base
  // BLANK_FORM when a user lands here or switches to this template.
  defaults: {
    include_non_circumvention: true,
    include_non_solicitation: true,
  },
  // Mandatory-section checks — the "missing sections" warning fires
  // when a loaded body no longer contains any of these markers.
  mandatorySections: [
    { name: 'WHISTLEBLOWER PROTECTION', test: /WHISTLEBLOWER PROTECTION/ },
    { name: 'SIGNATORIES',              test: /\bSIGNATORIES\./          },
  ],
  // Field keys (beyond BASE_BODY_FIELDS) that this template substitutes
  // into its body text — the dirty-mode diff uses this to know which
  // form fields to watch for changes.
  bodyFields: BASE_BODY_FIELDS,
  buildBody,
}

export default standard
