import { useState } from 'react'
import { analyseCase } from '../lib/ai'
import { getAiClient } from '../lib/aiClient'
import { agoText } from '../lib/geo'
import { db } from '../lib/firebase'
import { useAiDocs, useNow } from '../lib/store'
import type { AiBriefing, Case, Evidence, PatientPrivate } from '../lib/types'
import { saveAiDraft, shareHandoff, type Actor } from '../lib/workflow'
import { AiStamp, Icon, Notice, Pill, type Notify } from './ui'

function List({ title, items, tone }: { title: string; items: string[]; tone?: 'wait' | 'signal' }) {
  if (!items.length) return null
  return (
    <div className="stack-sm">
      <h4 className="h-sm">{title}</h4>
      <ul className="stack-sm" style={{ paddingLeft: 18, listStyle: 'disc', color: tone === 'signal' ? 'var(--signal)' : undefined }}>{items.map((x) => <li key={x}>{x}</li>)}</ul>
    </div>
  )
}

/** Read-only view of a briefing, for the people who receive it. Always labelled as AI-generated and reviewed. */
export function HandoffCard({ caseId }: { caseId: string }) {
  const { handoff } = useAiDocs(caseId, false, true)
  const now = useNow(30000)
  if (!handoff) return null
  return (
    <section className="panel panel--quiet" aria-label="Briefing from dispatch">
      <header className="panel-head"><h3 className="h">Briefing from dispatch</h3><div className="row row-tight"><AiStamp /><Pill tone="go">Reviewed by dispatch {handoff.reviewedAtMs ? agoText(handoff.reviewedAtMs, now) : ''}{handoff.edited ? ', corrected' : ''}</Pill></div></header>
      <div className="panel-body">
        <p className="measure">{handoff.handoff}</p>
        <List title="Not yet known" items={handoff.missingInformation} />
        <List title="Uncertain" items={handoff.uncertainties} tone="wait" />
        <List title="Conflicting information" items={handoff.conflicts} tone="signal" />
        <p className="fine">Drafted by an AI model ({handoff.model}) from the reporter&apos;s words and attachments, then checked by a dispatcher. It is not a diagnosis, treatment advice, or a statement about what any hospital has available. The original report and files are the source of truth.</p>
      </div>
    </section>
  )
}

/** The dispatcher's workspace: run the AI, correct its draft, and share the reviewed handoff. */
export function AiPanel({ c, evidence, evidenceReady, priv, actor, notify }: { c: Case; evidence: Evidence[]; evidenceReady: boolean; priv: PatientPrivate | null | undefined; actor: Actor; notify: Notify }) {
  const { draft, handoff } = useAiDocs(c.id, true, true)
  const now = useNow(30000)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ error: string; unavailable: boolean } | null>(null)
  const [skipped, setSkipped] = useState<string[]>([])
  // The reviewer's edits belong to one specific draft; a newly generated draft starts fresh from the AI's text.
  const [edits, setEdits] = useState<{ seed: number; summary?: string; handoff?: string } | null>(null)
  const ready = evidence.filter((e) => e.status === 'ready')
  const waiting = evidenceReady ? evidence.filter((e) => e.status !== 'ready').length + Math.max(0, c.evidenceExpected - evidence.length) : 0

  const mine = draft && edits?.seed === draft.generatedAtMs ? edits : null
  const summary = mine?.summary ?? draft?.summary ?? ''
  const handoffText = mine?.handoff ?? draft?.handoff ?? ''
  const setSummary = (v: string) => draft && setEdits({ seed: draft.generatedAtMs, handoff: mine?.handoff, summary: v })
  const setHandoffText = (v: string) => draft && setEdits({ seed: draft.generatedAtMs, summary: mine?.summary, handoff: v })

  async function run() {
    setBusy(true)
    setFailure(null)
    setSkipped([])
    try {
      const res = await analyseCase(db, await getAiClient(), c, evidence, priv?.note ?? '')
      if (res.ok) { setSkipped(res.skipped); notify('AI draft ready for your review.', 'good') } else setFailure({ error: res.error, unavailable: res.unavailable })
    } catch (e) {
      setFailure({ error: (e as Error).message, unavailable: false })
    } finally { setBusy(false) }
  }

  const edited = !!draft && (summary !== draft.summary || handoffText !== draft.handoff)
  const share = async () => {
    if (!draft) return
    setBusy(true)
    try {
      const next: AiBriefing = { ...draft, summary: summary.trim() || draft.summary, handoff: handoffText.trim().slice(0, 600) || draft.handoff, edited: edited || draft.edited }
      await saveAiDraft(db, c.id, { ...next, reviewedByUid: undefined, reviewedAtMs: undefined })
      await shareHandoff(db, actor, c.id, next)
      notify('Reviewed briefing shared with the crew and active hospitals.', 'good')
    } catch (e) { notify((e as Error).message, 'warn') } finally { setBusy(false) }
  }

  return (
    <section className="panel" aria-label="AI-assisted briefing">
      <header className="panel-head">
        <h3 className="h"><Icon name="spark" size={18} /> AI-assisted briefing</h3>
        <div className="row row-tight"><AiStamp />{handoff && <Pill tone="go">Shared {handoff.reviewedAtMs ? agoText(handoff.reviewedAtMs, now) : ''}</Pill>}</div>
      </header>
      <div className="panel-body">
        <p className="sub measure">The AI reads the report and the attached files and drafts a summary. It never diagnoses, advises treatment, claims hospital resources, or chooses who to dispatch. You review and correct it before anyone else sees it.</p>

        {waiting > 0 && <Notice tone="wait" title={`${waiting} file${waiting > 1 ? 's are' : ' is'} still arriving`}>The draft only covers files that have finished uploading. Run it again when they are in.</Notice>}
        {failure && <Notice tone={failure.unavailable ? 'wait' : 'signal'} title={failure.unavailable ? 'The AI is not available' : 'The AI could not produce a usable draft'}>{failure.error}</Notice>}
        {skipped.length > 0 && <Notice tone="wait" title="Not analysed"><ul>{skipped.map((s) => <li key={s}>{s}</li>)}</ul></Notice>}

        <div className="row">
          <button className="btn btn-ink" onClick={() => void run()} disabled={busy}>{busy ? <><span className="spin" /> Analysing</> : draft ? 'Run the AI again' : `Analyse report${ready.length ? ` and ${ready.length} file${ready.length > 1 ? 's' : ''}` : ''}`}</button>
          <span className="fine">Sent to Google Gemini through Firebase AI Logic. Use synthetic data only in this demonstration.</span>
        </div>

        {draft && (
          <div className="stack" aria-label="AI draft">
            <Notice tone="sim" title="Draft: not yet shared">{draft.model} wrote this {agoText(draft.generatedAtMs, now)}. Check it against the original report before sharing.</Notice>
            {draft.guardrailFlags.length > 0 && <Notice tone="wait" title="Parts of the AI's answer were removed">{draft.guardrailFlags.join('. ')}. These were outside what the AI is allowed to say.</Notice>}
            {draft.transcript && <div className="stack-sm"><h4 className="h-sm">Audio transcript</h4><blockquote className="inset" style={{ margin: 0 }}>{draft.transcript}</blockquote></div>}
            <label className="field"><span className="field-label">Summary <small>(you can correct it)</small></span><textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} maxLength={2000} /></label>
            <div className="cols-2">
              <div className="stack-sm">
                <h4 className="h-sm">Facts the AI found</h4>
                <dl className="inset stack-sm" style={{ margin: 0 }}>
                  <div><dt className="fine">Incident type</dt><dd>{draft.facts.incidentType ?? 'Not stated'}</dd></div>
                  <div><dt className="fine">Symptoms, as the reporter described them</dt><dd>{draft.facts.symptoms.join('; ') || 'Not stated'}</dd></div>
                  <div><dt className="fine">Location clues</dt><dd>{draft.facts.locationClues.join('; ') || 'None'}</dd></div>
                  <div><dt className="fine">Times mentioned</dt><dd>{draft.facts.timestamps.join('; ') || 'None'}</dd></div>
                  <div><dt className="fine">Patients mentioned</dt><dd>{draft.facts.patientCount ?? 'Not stated'}</dd></div>
                </dl>
              </div>
              <div className="stack-sm">
                <List title="Missing information" items={draft.missingInformation} />
                <List title="Uncertain" items={draft.uncertainties} tone="wait" />
                <List title="Conflicting evidence" items={draft.conflicts} tone="signal" />
              </div>
            </div>
            <label className="field"><span className="field-label">Handoff for crew and hospitals <small>({handoffText.length}/600)</small></span><textarea value={handoffText} onChange={(e) => setHandoffText(e.target.value.slice(0, 600))} rows={4} maxLength={600} /></label>
            <div className="row">
              <button className="btn btn-go" onClick={() => void share()} disabled={busy || !handoffText.trim()}>{handoff ? 'Update the shared briefing' : 'Review done: share with crew and hospitals'}</button>
              {edited && <Pill tone="sim">You edited the draft</Pill>}
            </div>
          </div>
        )}
        {!draft && handoff && <HandoffCard caseId={c.id} />}
      </div>
    </section>
  )
}
