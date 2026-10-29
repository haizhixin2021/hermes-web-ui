/** Bot appearance is independent of the runtime, model and conversation name. */
export const PERSON_BOTS = [
  { type: 'zhezhe', name: 'zhezhe', avatar: '/coding-agents/person.jpg' },
] as const

export const DEFAULT_PERSON_BOT_TYPE = 'zhezhe'

export function personBotNameKey(name: string) {
  return name.trim().normalize('NFKC').toLowerCase()
}

export function personBot(type: unknown) {
  return PERSON_BOTS.find(bot => bot.type === type)
}
