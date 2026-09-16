/*
 * Design-system primitive showcase. Not routed — this file exists as a
 * reference for anyone extending the primitives, and as a quick-mount target
 * for visual regression checks.
 *
 * To view temporarily, edit src/main.jsx:
 *
 *   import Showcase from './components/ui/Showcase'
 *   // replace <App /> with <Showcase /> in the render() call, then revert
 *
 * Do not add a route for this page in App.jsx.
 */

import { Button, Card, Input, Select, Textarea, Badge } from './index'

function Section({ title, children }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[11px] font-bold uppercase tracking-wider text-ink-muted">{title}</h2>
      <div className="flex flex-wrap items-start gap-3">{children}</div>
    </section>
  )
}

export default function Showcase() {
  return (
    <div className="bg-page min-h-screen p-10">
      <div className="max-w-3xl mx-auto space-y-10">
        <header>
          <h1 className="text-2xl font-bold text-ink">Design-system primitives</h1>
          <p className="text-sm text-ink-muted mt-1">
            Both themes share the same markup. Toggle <code className="font-mono">document.documentElement.classList.add('dark')</code> in the console to preview dark.
          </p>
        </header>

        <Section title="Button variants">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="primary" disabled>Disabled</Button>
        </Section>

        <Section title="Button sizes">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </Section>

        <Section title="Card">
          <Card className="w-80 p-5">
            <p className="text-sm text-ink font-semibold mb-1">Plain card</p>
            <p className="text-xs text-ink-muted">bg-card border border-rule rounded-xl.</p>
          </Card>
          <Card
            className="w-80"
            header={<p className="text-sm font-semibold text-ink">With slots</p>}
            footer={<p className="text-xs text-ink-muted">Footer copy</p>}
          >
            <div className="px-5 py-4 text-xs text-ink-muted">Body content sits between header and footer.</div>
          </Card>
        </Section>

        <Section title="Form primitives">
          <div className="w-80 space-y-3">
            <Input placeholder="Input" />
            <Select defaultValue="">
              <option value="" disabled>Pick one…</option>
              <option>Option A</option>
              <option>Option B</option>
            </Select>
            <Textarea placeholder="Textarea" rows={3} />
          </div>
        </Section>

        <Section title="Badge tones">
          <Badge tone="success">success</Badge>
          <Badge tone="warning">warning</Badge>
          <Badge tone="danger">danger</Badge>
          <Badge tone="info">info</Badge>
          <Badge tone="neutral">neutral</Badge>
        </Section>
      </div>
    </div>
  )
}
