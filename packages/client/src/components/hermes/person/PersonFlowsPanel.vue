<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NAlert, NButton } from 'naive-ui'
import type { PersonFlow } from '@/api/person'

defineProps<{ flows: PersonFlow[]; saving: boolean }>()
const emit = defineEmits<{ action: [flow: PersonFlow, action: 'stop' | 'resume']; openResult: [sessionId: string, messageId: number]; openTask: [taskId: string] }>()
const { t } = useI18n()
const stateLabel = (state: string) => t(`person.states.${({ active: 'running', completed: 'finished', stopped: 'interrupted' } as Record<string, string>)[state] || state}`)
</script>

<template>
  <section class="person-panel">
    <header class="panel-heading"><h2>{{ t('person.flows') }}</h2></header>
    <div v-if="!flows.length" class="panel-empty">{{ t('person.empty') }}</div>
    <article v-for="flow in flows" :key="flow.id" class="panel-tile flow-tile" data-theme-surface="card">
      <header class="tile-top"><h3>{{ flow.title }}</h3><span class="tile-meta">{{ stateLabel(flow.state) }}</span></header>
      <p class="flow-goal">{{ flow.goal }}</p>
      <NAlert v-if="flow.error" type="warning">{{ flow.error }}</NAlert>
      <ol class="flow-stages">
        <li v-for="stage in flow.stages" :key="stage.id">
          <div class="stage-heading"><strong>{{ stage.session_title || t('person.chat') }}</strong><span class="tile-meta">{{ stateLabel(stage.state) }}</span></div>
          <p class="flow-goal">{{ stage.goal }}</p>
          <NButton v-if="stage.result_message_id" text type="primary" @click="emit('openResult', stage.session_id, stage.result_message_id)">{{ t('person.viewResult') }}</NButton>
          <div v-for="task in stage.tasks" :key="task.id" class="flow-task">
            <NButton text @click="emit('openTask', task.id)">{{ t('person.backgroundTasks') }} · {{ task.title }}</NButton>
          </div>
        </li>
      </ol>
      <footer v-if="flow.state !== 'completed'" class="tile-footer">
        <NButton :disabled="saving" @click="emit('action', flow, flow.state === 'stopped' ? 'resume' : 'stop')">{{ t(flow.state === 'stopped' ? 'person.resume' : 'person.stopFlow') }}</NButton>
      </footer>
    </article>
  </section>
</template>

<style scoped lang="scss">
@use './person-panels';
.flow-tile { margin-bottom: 16px; }
.tile-top h3 { margin: 0; overflow-wrap: anywhere; }
.flow-goal { white-space: pre-wrap; overflow-wrap: anywhere; }
.flow-stages { padding-inline-start: 24px; }
.flow-stages li { padding: 12px 0; }
.stage-heading { display: flex; flex-wrap: wrap; gap: 12px; }
.flow-task { margin-top: 10px; overflow-wrap: anywhere; }
</style>
