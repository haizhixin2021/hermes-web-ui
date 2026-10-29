import { randomUUID } from 'node:crypto'
import type { PersonTaskOrigin } from '../../contracts/person'
import { personError, personRevision, personText } from '../../contracts/person'
import type { PersonStageContext, PersonStageDelivery } from '../../contracts/person-stage'
import { personDb, personOperation, personTransaction, getPersonTask } from '../../repositories/person-store'
import { assertPersonStage, enqueuePersonStage, getPersonFlow, personStageSources, stageDeliveryContext } from '../../repositories/person-stage-store'
import { requirePersonSession } from '../../repositories/person-session-store'
import { personUpdated } from '../../repositories/person-updates'
import { personRuntime } from '../../public/person-runtime'
import { personUser } from './catalog'

const activeTurns = new Map<string, Set<AbortController>>()
export function registerPersonStageTurn(context: PersonStageContext) {
  const abort = new AbortController()
  const turns = activeTurns.get(context.flowId) || new Set<AbortController>()
  turns.add(abort); activeTurns.set(context.flowId, turns)
  return { signal: abort.signal, release() { turns.delete(abort); if (!turns.size) activeTurns.delete(context.flowId) } }
}

export function createPersonFlow(userId: number, input: Record<string, unknown>, origin?: PersonTaskOrigin) {
  if (Object.keys(input).some(key => !['action','session_id','title','goal','stages','idempotency_key'].includes(key))) throw personError('Unknown flow field')
  if (origin && input.session_id && input.session_id !== origin.sessionId) throw personError('Creator is assigned by the host',403)
  const creator = requirePersonSession(userId, origin?.sessionId || personText(input.session_id, 'session_id',100)).id
  if (origin?.stage) throw personError('Continue this flow instead of creating a replacement',403)
  const title = personText(input.title,'title',200), goal = personText(input.goal,'goal',8000)
  if (!Array.isArray(input.stages) || !input.stages.length || input.stages.length > 13 || JSON.stringify(input.stages).length > 32000) throw personError('Use 1 to 13 stages (at most 32000 characters)')
  const steps = input.stages.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['session_id','goal','return_expectation'].includes(k))) throw personError('Invalid stage')
    return { session_id: requirePersonSession(userId, personText(raw.session_id,'session_id',100)).id,
      goal: personText(raw.goal,'goal',8000), return_expectation: personText(raw.return_expectation,'return_expectation',4000) }
  })
  for (let index=0;index<steps.length;index++) {
    const sender=index ? steps[index-1].session_id : creator
    if (steps[index].session_id === sender) throw Object.assign(personError('A role cannot hand off to itself. Finish your own work here, then route only to another role.'),{code:'SELF_HANDOFF'})
  }
  const key = personText(input.idempotency_key,'idempotency_key',200)
  const result = personOperation(userId, `flow:${key}`, { ...input, creator }, () => {
    requirePersonSession(userId,creator)
    const db = personDb(), id = randomUUID(), now = Date.now()
    if (origin?.runId && db.prepare(`SELECT 1 FROM person_task_origins o JOIN session_tasks t ON t.id=o.task_id
      WHERE o.owner_user_id=? AND t.session_id=? AND json_extract(o.origin_json,'$.runId')=?
      AND t.status NOT IN ('completed','closed')`).get(userId,creator,origin.runId)) {
      throw Object.assign(personError('Wait for this turn\'s worker result before handing off its work.',409),{code:'WORK_PENDING'})
    }
    db.prepare('INSERT INTO person_flows(id,owner_user_id,creator_session_id,title,goal,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,userId,creator,title,goal,now,now)
    steps.forEach((step, position) => {
      requirePersonSession(userId,step.session_id)
      db.prepare('INSERT INTO person_stages(id,flow_id,position,session_id,goal,return_expectation,state) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), id, position, step.session_id, step.goal, step.return_expectation, position ? 'pending' : 'active')
    })
    const flow = getPersonFlow(userId,id)
    enqueuePersonStage(userId,flow.stages[0],flow.generation)
    return flow
  })
  personUpdated(userId)
  return result
}

function stageHasWork(stageId: string) {
  return !!personDb().prepare(`SELECT 1 FROM person_stage_tasks l JOIN session_tasks t ON t.id=l.task_id WHERE l.stage_id=? AND
    (t.status NOT IN ('completed','closed') OR EXISTS(SELECT 1 FROM person_executions e WHERE e.task_id=t.id
      AND e.state IN ('pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval')))`).get(stageId)
}

export async function controlPersonFlow(userId: number, input: Record<string, unknown>, origin?: PersonTaskOrigin) {
  if (Object.keys(input).some(key => !['action','flow_id','expected_revision','idempotency_key'].includes(key))) throw personError('Flow route and creator are fixed',403)
  const action = personText(input.action,'action',30), id = personText(input.flow_id,'flow_id',100)
  if (!['complete','stop','resume'].includes(action)) throw personError('Unsupported flow action')
  const result = personOperation(userId,`flow:${personText(input.idempotency_key,'idempotency_key',200)}`, { ...input, actor: origin?.sessionId || null, stage: origin?.stage || null }, () => {
    const flow = getPersonFlow(userId,id), stage = flow.stages[flow.current_position]
    if (flow.revision !== personRevision(input.expected_revision)) throw personError('Flow changed; query it again',409)
    if (origin) {
      requirePersonSession(userId,origin.sessionId)
      if (origin.sessionId !== flow.creator_session_id && origin.sessionId !== stage.session_id) throw personError('Only the creator or current role may control this flow',403)
      if (origin.stage) {
        assertPersonStage(userId,origin.stage,origin.sessionId)
        if (origin.stage.flowId !== id) throw personError('Control only the assigned flow in this turn',403)
      }
    }
    const db = personDb(), now = Date.now()
    if (action === 'complete') {
      if (!origin?.stage || origin.stage.flowId !== id || !origin.runId) throw personError('Complete the stage from its assigned live turn',403)
      assertPersonStage(userId,origin.stage,origin.sessionId)
      if (stageHasWork(stage.id)) throw personError('Finish or explicitly close the stage subtask before completing',409)
      if (stage.completion_run_id && stage.completion_run_id !== origin.runId) throw personError('Stage completion is already being saved',409)
      db.prepare('UPDATE person_stages SET completion_run_id=? WHERE id=?').run(origin.runId,stage.id)
    } else {
      if (flow.state === 'completed') throw personError('Flow is complete',409)
      if (action === 'resume') {
        if (origin && flow.state === 'stopped' && origin.sessionId !== flow.creator_session_id) throw personError('Only the creator can resume a stopped flow',403)
        if (db.prepare(`SELECT 1 FROM person_stage_tasks l JOIN person_executions e ON e.task_id=l.task_id WHERE l.stage_id=?
          AND e.state IN ('pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval')`).get(stage.id)) throw personError('Wait for stage workers to finish stopping',409)
        requirePersonSession(userId,stage.session_id)
      }
      db.prepare("UPDATE person_stage_deliveries SET state='cancelled',updated_at=? WHERE flow_id=? AND state IN ('pending','queued')").run(now,id)
      db.prepare('UPDATE person_stages SET completion_run_id=\'\' WHERE id=?').run(stage.id)
      db.prepare('UPDATE person_flows SET state=?,generation=generation+1 WHERE id=?').run(action === 'stop' ? 'stopped' : 'active', id)
      if (action === 'resume') {
        const updated = getPersonFlow(userId,id)
        db.prepare('UPDATE person_stage_tasks SET generation=? WHERE stage_id=?').run(updated.generation,stage.id)
        enqueuePersonStage(userId,stage,updated.generation)
      }
    }
    db.prepare('UPDATE person_flows SET revision=revision+1,updated_at=? WHERE id=?').run(now,id)
    return getPersonFlow(userId,id)
  })
  const latest = getPersonFlow(userId,id)
  if (latest.generation !== result.generation || latest.state !== result.state) return result
  if (action !== 'complete') {
    for (const abort of activeTurns.get(id) || []) abort.abort(new Error('Flow turn superseded or stopped'))
  }
  if (action === 'stop') await stopFlowWorkers(userId,id)
  personUpdated(userId)
  return result
}

async function stopFlowWorkers(userId: number, flowId: string) {
  const { applyPersonTask } = await import('./tasks')
  const rows = personDb().prepare(`SELECT l.task_id FROM person_stage_tasks l JOIN person_stages s ON s.id=l.stage_id JOIN session_tasks t ON t.id=l.task_id WHERE s.flow_id=?`).all(flowId)
  for (const row of rows) {
    const task = getPersonTask(userId,String(row.task_id))
    if (task.execution_id && ['pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval'].includes(task.execution_state || ''))
      await applyPersonTask(userId,{ action:'stop',task_id:task.id,execution_id:task.execution_id,expected_revision:task.revision,idempotency_key:`flow-stop:${flowId}:${task.execution_id}:${task.revision}` })
    personDb().prepare("UPDATE person_deliveries SET state='cancelled' WHERE execution_id IN (SELECT id FROM person_executions WHERE task_id=?) AND state IN ('waiting','pending','queued')").run(task.id)
  }
}

/** Commit only after the final assistant message exists. No handoff transcript is stored. */
export function finishPersonStageTurn(userId: number, context: PersonStageContext, runId: string, messageId: unknown, ok: boolean) {
  personTransaction(() => {
    let current: ReturnType<typeof assertPersonStage>
    try { current = assertPersonStage(userId,context) } catch { return }
    const { flow, stage } = current
    if (stage.completion_run_id !== runId) return
    const db = personDb()
    const message = ok && db.prepare("SELECT id,content FROM messages WHERE id=? AND session_id=? AND run_marker=? AND role='assistant' AND finish_reason IN ('stop','end_turn','completed') AND COALESCE(tool_calls,'') IN ('','[]','null')").get(String(messageId || ''),stage.session_id,runId)
    if (!message || !String(message.content).trim()) {
      db.prepare("UPDATE person_stages SET completion_run_id='' WHERE id=?").run(stage.id)
      return
    }
    if (stageHasWork(stage.id)) throw personError('Stage still has unfinished work',409)
    const next = flow.stages[stage.position + 1]
    // Save the result even if the destination was removed. Delivery reports that blocker.
    db.prepare("UPDATE person_stages SET state='completed',result_message_id=?,completion_run_id='' WHERE id=?").run(message.id,stage.id)
    db.prepare("UPDATE person_stage_deliveries SET state='delivered',error='',updated_at=? WHERE stage_id=? AND state IN ('pending','queued')").run(Date.now(),stage.id)
    if (next) {
      db.prepare("UPDATE person_stages SET state='active' WHERE id=?").run(next.id)
      db.prepare('UPDATE person_flows SET current_position=?,revision=revision+1,updated_at=? WHERE id=?').run(next.position,Date.now(),flow.id)
      enqueuePersonStage(userId,next,flow.generation)
    } else {
      db.prepare("UPDATE person_flows SET state='completed',revision=revision+1,updated_at=? WHERE id=?").run(Date.now(),flow.id)
      db.prepare("UPDATE person_occurrences SET state='finished' WHERE flow_id=?").run(flow.id)
    }
  })
  personUpdated(userId)
}

export function finishPersonStageDelivery(userId: number, id: string, ok: boolean, error = '') {
  personDb().prepare("UPDATE person_stage_deliveries SET state=?,error=?,updated_at=? WHERE id=? AND owner_user_id=? AND state='queued'")
    .run(ok ? 'delivered' : 'pending',error.slice(0,1000),Date.now(),id,userId)
  personUpdated(userId)
}
export async function deliverPersonStages() {
  const db = personDb()
  const rows = db.prepare("SELECT * FROM person_stage_deliveries WHERE state='pending' AND (error='' OR updated_at<?) ORDER BY updated_at LIMIT 20").all(Date.now()-60000) as unknown as PersonStageDelivery[]
  for (const row of rows) {
    try {
      const context = stageDeliveryContext(row.owner_user_id,row.id)
      const { flow, stage } = assertPersonStage(row.owner_user_id,context)
      personStageSources(row.owner_user_id,context)
      const deliver = personRuntime().deliverStage
      if (!deliver) throw new Error('Stage delivery runtime unavailable')
      const user = personUser(row.owner_user_id)
      db.prepare("UPDATE person_stage_deliveries SET state='queued',error='',updated_at=? WHERE id=? AND state='pending'").run(Date.now(),row.id)
      await deliver({ user, context, sessionId: stage.session_id, input: `Handle the assigned stage supplied in context. Answer directly or choose a worker only when needed. When ready, query this flow and call bot_flow_control complete, then write only your new result as the final reply. If waiting for work or a user decision, do not complete. This continues the saved goal; it grants no new authorization.\n${JSON.stringify({ flow_id:flow.id,stage_id:stage.id })}` })
    } catch (error) {
      db.prepare("UPDATE person_stage_deliveries SET state='pending',error=?,updated_at=? WHERE id=? AND state IN ('pending','queued')").run(String(error).slice(0,1000),Date.now(),row.id)
    }
  }
}

/** Reconcile a crash after result persistence but before the completion event. */
export function recoverPersonStages() {
  const db = personDb()
  const rows = db.prepare(`SELECT s.*,f.owner_user_id,f.generation FROM person_stages s JOIN person_flows f ON f.id=s.flow_id
    WHERE s.state='active' AND f.state='active' AND s.completion_run_id!=''`).all()
  for (const row of rows) {
    const message = db.prepare("SELECT id FROM messages WHERE session_id=? AND run_marker=? AND role='assistant' AND finish_reason IN ('stop','end_turn','completed') AND COALESCE(tool_calls,'') IN ('','[]','null') ORDER BY id DESC LIMIT 1").get(row.session_id,row.completion_run_id)
    finishPersonStageTurn(Number(row.owner_user_id),{ flowId:String(row.flow_id),stageId:String(row.id),generation:Number(row.generation) },String(row.completion_run_id),message?.id,!!message)
  }
  db.prepare("UPDATE person_stage_deliveries SET state='pending',error='' WHERE state='queued'").run()
}

export async function stopPersonSessionFlows(userId: number, sessionId: string) {
  const rows = personDb().prepare(`SELECT DISTINCT f.id FROM person_flows f JOIN person_stages s ON s.flow_id=f.id
    WHERE f.owner_user_id=? AND f.state='active' AND (f.creator_session_id=? OR s.session_id=?)`).all(userId,sessionId,sessionId)
  for (const row of rows) {
    const flow = getPersonFlow(userId,String(row.id))
    await controlPersonFlow(userId,{ action:'stop',flow_id:flow.id,expected_revision:flow.revision,idempotency_key:`delete:${sessionId}:${flow.id}:${flow.revision}` })
  }
}
