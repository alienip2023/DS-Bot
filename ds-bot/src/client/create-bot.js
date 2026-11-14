import { failureText } from './error-text.js'
import { createElement as h, useEffect, useRef, useState } from 'react'
import { BotMark } from './mark.js'
import { CharacterGrid } from './bot-settings.js'
import { AvatarLibraryPanel, avatarImage } from './avatar-library.js'
import { DEFAULT_SHAPES, DEFAULT_COLORS } from './characters.js'
import { ChevronLeftIcon, CloseIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { createPayload, freshBotName, startModel } from './bot-draft.js'
import { ModelMenu, useAgentModels } from './model-menu.js'
import { CliList, ReadingModels, RunModeSwitch, useLocalAgents } from './agent-cards.js'
import { agentAvatar, modelsFor, routeOf } from './agent-routes.js'
import { hostText, t } from './i18n.js'
import { canFederate, memoryBackendChoices } from './memory-backends.js'
import { pickTargets } from './pick-targets.js'
import { nameProblem } from '../shared/mentions.js'

const pick = list => list[Math.floor(Math.random() * list.length)]
const randomLook = (avoid = {}) => {
  const shapes = DEFAULT_SHAPES.filter(shape => shape !== avoid.shape)
  const colors = DEFAULT_COLORS.filter(color => color !== avoid.color)
  return { shape: pick(shapes), color: pick(colors) }
}

// The new-Bot form: what it runs on, then look, name and model. Nothing exists until Create.
// `inline` drops the pane's header for a form shown inside Settings.
export function CreateBot({ roster, actions, start, brief = '', onBack, canGoBack, onCreated, inline = false }) {
  const [look, setLook] = useState(() => randomLook())
  const [image, setImage] = useState(null)
  const [library, setLibrary] = useState(false)
  const [name, setName] = useState(start?.name ?? '')
  const [mode, setMode] = useState('model')
  const [model, setModel] = useState(() => startModel(roster))
  const [agentModel, setAgentModel] = useState('')
  const [ownLook, setOwnLook] = useState(false)
  const [effort, setEffort] = useState(undefined)
  const [botType, setBotType] = useState('normal')
  const [memoryBackend, setMemoryBackend] = useState('auto')
  const [hubUrl, setHubUrl] = useState('')
  const [remotePort, setRemotePort] = useState('19387')
  const [workerToken, setWorkerToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Remote node selection: '' = this machine, a nodeId = create on that node
  const [targetNodeId, setTargetNodeId] = useState('')
  const [remoteNodes, setRemoteNodes] = useState([])
  const fileRef = useRef(null)
  const frame = useRef(null)
  // When a remote node is selected, skip the worker-bot form fields entirely.
  const isRemoteNode = targetNodeId !== ''
  // A local agent is a CLI on THIS machine: not for a Bot created on a node, nor for a Worker Bot.
  const canRunLocal = !isRemoteNode && botType !== 'remote-worker'
  const local = mode === 'local' && canRunLocal
  const localAgents = useLocalAgents(local)
  const [reading, readModels] = useAgentModels(actions)
  const chosen = local ? agentModel : model
  useEscape(onBack)
  // Inside Settings the form opens below other sections, so it scrolls itself into view.
  useEffect(() => { if (inline) frame.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, [])
  // Fetch online nodes so the user can pick a machine.
  useEffect(() => {
    let cancelled = false
    actions.botCreateTargets?.().then(res => {
      const list = pickTargets(res)
      if (!cancelled) setRemoteNodes(list)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  const fallbackName = freshBotName(roster, t('New Bot'))
  const finalName = name.trim() || fallbackName
  const clash = roster.bots.some(bot => bot.name.toLowerCase() === finalName.toLowerCase())
  const problem = nameProblem(finalName)
  // The node's catalog for the picker of a Bot created on that node.
  const nodeRoster = isRemoteNode
    ? { ...roster, models: (remoteNodes.find(node => node.nodeId === targetNodeId)?.models ?? []).map(m => ({ ref: m.ref, provider: m.provider, name: m.name, providerName: m.provider })) }
    : roster
  const nodeCatalogEmpty = isRemoteNode && nodeRoster.models.length === 0
  const blocked = busy || clash || Boolean(problem) || (local && chosen === '') || nodeCatalogEmpty
  const create = async () => {
    if (blocked) return
    setError('')
    setBusy(true)
    try {
      if (isRemoteNode) {
        if (!model) { setError(t('Please select a model')); setBusy(false); return }
        const result = await actions.createBot({ nodeId: targetNodeId, name: finalName, role: '', model, effort: effort || undefined })
        onCreated(result?.value ?? result)
        return
      }
      const extra = botType === 'remote-worker'
        ? { type: 'remote-worker', worker: { hubUrl: hubUrl.trim() || undefined, remotePort: remotePort ? Number(remotePort) : undefined, token: workerToken.trim() || undefined } }
        : {}
      const bot = await actions.createBot({ ...createPayload({ name: finalName, look, image, model: chosen, effort: local ? undefined : effort, brief, ownLook, sectionId: start?.sectionId }), memoryConfig: { backend: memoryBackend }, ...extra })
      onCreated(bot)
    } catch (failure) {
      setError(failureText(failure))
      setBusy(false)
    }
  }
  const upload = (file) => {
    if (!file) return
    setError('')
    avatarImage(file).then(setImage, failure => setError(failure?.message ?? String(failure)))
  }
  const pickAgent = (agent) => {
    setAgentModel(`${agent.route}/default`)
    readModels(agent.route)
  }
  const worn = local && chosen !== '' && !ownLook ? agentAvatar(routeOf(chosen))?.image : undefined
  const previewLook = image ? { ...look, image } : worn ? { ...look, image: worn } : look
  const card = h('div', { className: 'bt-create-card' },
    canRunLocal ? h(RunModeSwitch, { mode, setMode }) : null,
    h('div', { className: 'bt-create-preview' },
      // The key remounts the mark, so every new pick plays the pop.
      h('span', { key: `${look.shape}:${look.color}:${previewLook.image ? 'photo' : ''}`, className: 'bt-create-pop' },
        h(BotMark, { look: previewLook, bot: { id: 'new-bot' }, size: 88, live: true, gaze: true, pokeable: true })),
      h('span', { className: 'bt-create-name' }, finalName)),
    h('div', { className: 'bt-create-step' }, t('Look')),
    h('div', { className: 'bt-create-looks' },
      h(CharacterGrid, {
        look, hasPhoto: Boolean(image),
        onShape: (shape) => { setImage(null); setOwnLook(true); setLook(current => ({ ...current, shape })) },
        onColor: (color) => { setImage(null); setOwnLook(true); setLook(current => ({ ...current, color })) },
      }),
      h('div', { className: 'bt-actions bt-create-lookbar' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => { setImage(null); setOwnLook(true); setLook(current => randomLook(current)) } }, t('Shuffle')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => fileRef.current?.click() }, image ? t('Replace photo') : t('Upload photo')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-expanded': library, onClick: () => setLibrary(value => !value) }, t('Library')),
        image ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setImage(null) }, t('Remove photo')) : null,
        h('input', { ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, onChange: (event) => { const file = event.target.files?.[0]; event.target.value = ''; upload(file) } }))),
    // The library is a block of its own under the look, not a part of the button row.
    library ? h(AvatarLibraryPanel, { actions, onPick: entry => { setImage(entry.image); setLibrary(false) } }) : null,
    h('label', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Name')),
      h('input', {
        className: 'bt-input', autoFocus: !inline, value: name, placeholder: fallbackName, maxLength: 40, 'aria-label': t('Name'),
        onChange: event => setName(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void create() } },
      }),
      problem ? h('span', { className: 'bt-note bt-danger' }, hostText(problem))
        : clash ? h('span', { className: 'bt-note bt-danger' }, t('A Bot named {name} already exists', { name: finalName })) : null),
    local ? h('div', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Local agent')),
      h(CliList, { ...localAgents, selected: routeOf(chosen), onPick: pickAgent, actions })) : null,
    !local || chosen !== '' ? h('div', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Model'), local && reading ? h(ReadingModels) : null),
      h(ModelMenu, { bot: { id: 'new-bot', name: finalName, model: chosen || undefined, effort: local ? undefined : effort, ...(isRemoteNode ? { origin: 'joined', worker: { home: 'remote' } } : {}) }, roster: isRemoteNode ? nodeRoster : roster, actions, wide: true, onPick: (ref) => { if (local) { setAgentModel(ref); return } setModel(ref); setEffort(undefined) }, onPickEffort: picked => setEffort(picked ?? null) }),
      h('span', { className: 'bt-note' }, chosen
        ? t('The Bot runs on this model. You can change it later in its details.')
        : (isRemoteNode ? nodeRoster.models : modelsFor(roster.models)).length > 0
          ? t('Pick a model here, or the Bot asks for one in its chat.')
          : t('Add a provider and a model in DeepSeek Harness first, or pick one in the Bot\'s chat later.'))) : null,
    h('div', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Machine')),
      h('select', {
        className: 'bt-input', value: targetNodeId,
        onChange: e => {
          const next = e.target.value
          setTargetNodeId(next)
          // Back on this machine, a model that only exists on the node must not be sent to the hub.
          if (next === '') {
            const hubRefs = (roster.models ?? []).map(m => m.ref)
            if (!hubRefs.includes(model)) {
              setModel(startModel(roster))
              setEffort(undefined)
            }
            return
          }
          const node = remoteNodes.find(n => n.nodeId === next)
          const refs = (node?.models ?? []).map(m => m.ref)
          if (refs.includes(model)) return
          if (node?.defaultModel && refs.includes(node.defaultModel)) {
            setModel(node.defaultModel)
            setEffort(undefined)
          }
        },
        'aria-label': t('Machine'),
      },
        h('option', { value: '' }, t('This machine')),
        remoteNodes.map(n => h('option', { key: n.nodeId, value: n.nodeId }, n.hostname ?? n.nodeId))),
      h('span', { className: 'bt-note' }, targetNodeId
        ? (nodeCatalogEmpty
          ? t('This machine\'s model catalog has not synced yet.')
          : t('The Bot will be created on the selected remote machine.'))
        : remoteNodes.length === 0
          ? t('No connected remote machines yet.')
          : t('Create the Bot on this machine, or pick a connected remote machine.'))),
    !isRemoteNode ? h('div', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Type')),
      h('select', {
        className: 'bt-input', value: botType,
        onChange: e => setBotType(e.target.value),
        'aria-label': t('Bot type'),
      },
        h('option', { value: 'normal' }, t('Normal Bot')),
        h('option', { value: 'remote-worker' }, t('Worker Bot (Remote Machine)'))),
      h('span', { className: 'bt-note' }, botType === 'remote-worker'
        ? t('A Worker Bot runs tasks on a remote machine via dsh-remote-agent.')
        : t('A normal Bot runs in this DeepSeek Harness instance.'))) : null,
    !isRemoteNode ? h('div', { className: 'bt-field' },
      h('span', { className: 'bt-field-label' }, t('Memory Backend')),
      h('select', {
        className: 'bt-input', value: memoryBackend,
        onChange: e => setMemoryBackend(e.target.value),
        'aria-label': t('Memory backend'),
      },
        memoryBackendChoices({ federate: canFederate(roster) }).map(choice => h('option', { key: choice.value, value: choice.value }, t(choice.label)))),
      h('span', { className: 'bt-note' }, t('Where this Bot keeps its memory. Auto Detect uses dsh-mneme when it is installed.'))) : null,
    !isRemoteNode && botType === 'remote-worker' ? h('div', null,
      h('label', { className: 'bt-field' },
        h('span', { className: 'bt-field-label' }, t('Hub URL')),
        h('input', { className: 'bt-input', value: hubUrl, placeholder: 'https://hub.example.com', 'aria-label': t('Hub URL'), onChange: e => setHubUrl(e.target.value) }),
        h('span', { className: 'bt-note' }, t('URL of the hub the worker should connect to.'))),
      h('label', { className: 'bt-field' },
        h('span', { className: 'bt-field-label' }, t('Remote Port')),
        h('input', { className: 'bt-input', type: 'number', value: remotePort, placeholder: '19387', 'aria-label': t('Remote port'), onChange: e => setRemotePort(e.target.value) }),
        h('span', { className: 'bt-note' }, t('Port on the remote machine (default 19387).'))),
      h('label', { className: 'bt-field' },
        h('span', { className: 'bt-field-label' }, t('Token')),
        h('input', { className: 'bt-input', value: workerToken, placeholder: t('Enrollment token'), 'aria-label': t('Enrollment token'), onChange: e => setWorkerToken(e.target.value) }),
        h('span', { className: 'bt-note' }, t('Enrollment token for pairing this worker.')))) : null,
    error ? h('div', { className: 'bt-error', role: 'alert', style: { padding: 0 } }, error) : null,
    h('div', { className: 'bt-create-foot' },
      h('button', { type: 'button', className: 'bt-soft', onClick: onBack }, canGoBack ? t('Back') : t('Cancel')),
      h('button', { type: 'button', className: 'bt-send bt-create-go', disabled: blocked, onClick: () => void create() }, busy ? t('Creating…') : t('Create'))))
  if (inline) return h('div', { ref: frame, className: 'bt-create-inline', role: 'group', 'aria-label': t('Create Bot') }, card)
  return h('div', { className: 'bt-create', role: 'dialog', 'aria-label': t('Create Bot') },
    h('div', { className: 'bt-create-head' },
      canGoBack ? h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back to new chat'), onClick: onBack }, h(ChevronLeftIcon)) : h('span', { className: 'bt-create-gap' }),
      h('span', { className: 'bt-create-title' }, t('Create Bot')),
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: () => actions.closeOverlay() }, h(CloseIcon))),
    h('div', { className: 'bt-create-body' }, card))
}
