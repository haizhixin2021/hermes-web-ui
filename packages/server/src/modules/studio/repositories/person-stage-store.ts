import { randomUUID } from 'node:crypto'
import type { PersonConversationFlow, PersonStage, PersonStageContext, PersonStageDelivery } from '../contracts/person-stage'
import { personError } from '../contracts/person'
import { personDb } from './person-store'
import { requirePersonSession } from './person-session-store'

export function getPersonFlow(userId: number, id: string): PersonConversationFlow {
  const db = personDb()
  const row = db.prepare('SELECT * FROM person_flows WHERE id=? AND owner_user_id=?').get(id, userId)
  if (!row) throw personError('Flow not found', 404)
  const stages = db.prepare('SELECT s.*,c.title AS session_title FROM person_stages s LEFT JOIN sessions c ON c.id=s.session_id WHERE flow_id=? ORDER BY position').all(id) as unknown as PersonStage[]
  for (const stage of stages) stage.tasks = db.prepare('SELECT t.id,t.title,t.status FROM person_stage_tasks l JOIN session_tasks t ON t.id=l.task_id WHERE l.stage_id=? ORDER BY t.created_at,t.id').all(stage.id) as unknown as PersonStage['tasks']
  const error = db.prepare("SELECT error FROM person_stage_deliveries WHERE flow_id=? AND state='pending' ORDER BY updated_at DESC LIMIT 1").get(id)?.error || ''
  return { ...row, stages, error } as unknown as PersonConversationFlow
}
export function listPersonFlows(userId: number, sessionId = '', offset = 0) {
  return personDb().prepare(`SELECT f.id FROM person_flows f WHERE owner_user_id=? AND
    (?='' OR creator_session_id=? OR EXISTS(SELECT 1 FROM person_stages s WHERE s.flow_id=f.id AND s.session_id=?))
    ORDER BY updated_at DESC,id LIMIT 20 OFFSET ?`).all(userId, sessionId, sessionId, sessionId, offset).map(row => getPersonFlow(userId, String(row.id)))
}
export function assertPersonStage(userId: number, context: PersonStageContext, sessionId?: string) {
  const flow = getPersonFlow(userId, context.flowId)
  const stage = flow.stages[flow.current_position]
  if (flow.state !== 'active' || flow.generation !== context.generation || stage?.id !== context.stageId || stage.state !== 'active') throw personError('Flow stage is no longer current', 409)
  if (sessionId && stage.session_id !== sessionId) throw personError('Stage belongs to another conversation', 403)
  requirePersonSession(userId, stage.session_id)
  if (context.deliveryId) {
    const delivery = personDb().prepare("SELECT 1 FROM person_stage_deliveries WHERE id=? AND stage_id=? AND generation=? AND state IN ('pending','queued')").get(context.deliveryId, stage.id, context.generation)
    if (!delivery) throw personError('Stage delivery was cancelled or already handled', 409)
  }
  return { flow, stage }
}
export function personTaskStage(userId: number, taskId: string): PersonStageContext | undefined {
  const row = personDb().prepare(`SELECT s.flow_id,s.id,l.generation FROM person_stage_tasks l JOIN person_stages s ON s.id=l.stage_id
    JOIN person_flows f ON f.id=s.flow_id WHERE l.task_id=? AND f.owner_user_id=?`).get(taskId, userId)
  return row ? { flowId: String(row.flow_id), stageId: String(row.id), generation: Number(row.generation) } : undefined
}
export function assertPersonStageTask(userId: number, taskId: string) {
  const context = personTaskStage(userId, taskId)
  if (context && assertPersonStage(userId, context).stage.completion_run_id) throw personError('Finish the prepared stage reply first',409)
  return context
}
export function linkPersonStageTask(userId: number, taskId: string, context: PersonStageContext, sessionId: string) {
  const { stage } = assertPersonStage(userId, context, sessionId)
  if (stage.completion_run_id) throw personError('Stage completion was requested; finish the reply first', 409)
  personDb().prepare('INSERT INTO person_stage_tasks VALUES(?,?,?)').run(taskId, stage.id, context.generation)
}
export function enqueuePersonStage(userId: number, stage: PersonStage, generation: number) {
  personDb().prepare('INSERT OR IGNORE INTO person_stage_deliveries(id,owner_user_id,flow_id,stage_id,generation,updated_at) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), userId, stage.flow_id, stage.id, generation, Date.now())
}

/** A saved timer starts its own role turn, rather than a role handing off to itself.
 * Caller owns the occurrence transaction. The usual stage lifecycle lets the role
 * answer directly or wait for its optional workers before completing. */
export function enqueuePersonScheduledStage(userId: number, sessionId: string, title: string, goal: string) {
  requirePersonSession(userId, sessionId)
  const db = personDb(), id = randomUUID(), now = Date.now()
  db.prepare('INSERT INTO person_flows(id,owner_user_id,creator_session_id,title,goal,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, userId, sessionId, title, goal, now, now)
  db.prepare("INSERT INTO person_stages(id,flow_id,position,session_id,goal,return_expectation,state) VALUES(?,?,0,?,?,?,'active')")
    .run(randomUUID(), id, sessionId, goal, 'Complete the saved scheduled goal and report the new result. Use a background worker only when needed.')
  const flow = getPersonFlow(userId, id)
  enqueuePersonStage(userId, flow.stages[0], flow.generation)
  return id
}
export function getPersonStageDelivery(userId: number, id: string): PersonStageDelivery {
  const row = personDb().prepare('SELECT * FROM person_stage_deliveries WHERE id=? AND owner_user_id=?').get(id,userId)
  if (!row) throw personError('Stage delivery not found',404)
  return row as unknown as PersonStageDelivery
}
export function stageDeliveryContext(userId: number, id: string): PersonStageContext {
  const row = getPersonStageDelivery(userId, id)
  const context = { flowId: row.flow_id, stageId: row.stage_id, generation: row.generation, deliveryId: row.id }
  assertPersonStage(userId,context)
  return context
}

/** Required inputs are read from originals, never copied into recipient history. */
export function personStageSources(userId: number, context: PersonStageContext) {
  const { flow } = assertPersonStage(userId, context)
  const previous = flow.stages[flow.current_position - 1]
  if (!previous) return []
  requirePersonSession(userId, previous.session_id)
  const row = personDb().prepare("SELECT id,session_id,content FROM messages WHERE id=? AND session_id=? AND role='assistant' AND COALESCE(finish_reason,'')!='streaming'").get(previous.result_message_id, previous.session_id)
  if (!row) throw personError('Previous stage result is unavailable', 409)
  // Bound inline context; the exact message remains readable via bot_context_search.
  return [{ id: Number(row.id), session_id: String(row.session_id), content: String(row.content).slice(0,6000), truncated: String(row.content).length > 6000 }]
}
