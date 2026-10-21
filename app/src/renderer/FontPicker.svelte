<script module lang="ts">
  let pickerCount = 0
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import Icon from './Icon.svelte'

  let {
    value = $bindable(''),
    suggestions,
    label,
    onValueChange,
  }: {
    value?: string
    suggestions: string[]
    label: string
    onValueChange?: () => void
  } = $props()

  const listId = `font-picker-list-${++pickerCount}`
  let open = $state(false)
  let query = $state('')
  let activeIndex = $state(-1)
  let fieldElement = $state<HTMLDivElement | null>(null)
  let inputElement = $state<HTMLInputElement | null>(null)
  let listElement = $state<HTMLDivElement | null>(null)
  let listStyle = $state('')

  const filtered = $derived.by(() => {
    const search = query.trim().toLocaleLowerCase('ru')
    const matches = search ? suggestions.filter((font) => font.toLocaleLowerCase('ru').includes(search)) : suggestions
    return matches.slice(0, 100)
  })

  function positionList(): void {
    if (!inputElement) return
    const rect = inputElement.getBoundingClientRect()
    const height = Math.min(listElement?.scrollHeight ?? 260, 260)
    const above = window.innerHeight - rect.bottom < height + 18 && rect.top > height + 18
    const top = Math.max(8, above ? rect.top - height - 6 : rect.bottom + 6)
    listStyle = `top:${Math.round(top)}px; left:${Math.round(rect.left)}px; width:${Math.round(rect.width)}px`
  }

  async function showList(): Promise<void> {
    open = true
    activeIndex = -1
    await tick()
    positionList()
  }

  function hideList(): void {
    open = false
    activeIndex = -1
  }

  function toggleList(): void {
    if (open) {
      hideList()
      return
    }
    query = ''
    void showList()
    inputElement?.focus()
  }

  function handleInput(event: Event): void {
    if (!(event.currentTarget instanceof HTMLInputElement)) return
    value = event.currentTarget.value
    query = value
    activeIndex = -1
    if (open) void positionList()
    else void showList()
    onValueChange?.()
  }

  function choose(font: string): void {
    value = font
    hideList()
    onValueChange?.()
    inputElement?.focus()
  }

  function moveActive(delta: number): void {
    if (!filtered.length) return
    const index = activeIndex < 0
      ? delta > 0 ? 0 : filtered.length - 1
      : (activeIndex + delta + filtered.length) % filtered.length
    activeIndex = index
    void tick().then(() => {
      listElement?.querySelector<HTMLElement>(`[data-font-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
    })
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        query = ''
        void showList()
        return
      }
      moveActive(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Enter' && open) {
      const font = filtered[activeIndex]
      if (font) {
        event.preventDefault()
        choose(font)
      }
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      hideList()
      return
    }
    if (event.key === 'Tab') hideList()
  }

  function handleFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget
    if (next instanceof Node && fieldElement?.contains(next)) return
    hideList()
  }

  $effect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && fieldElement?.contains(event.target)) return
      hideList()
    }
    const closeOnViewportChange = () => hideList()
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', closeOnViewportChange, true)
    window.addEventListener('resize', closeOnViewportChange)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', closeOnViewportChange, true)
      window.removeEventListener('resize', closeOnViewportChange)
    }
  })
</script>

<div class="font-picker" bind:this={fieldElement} onfocusout={handleFocusOut}>
  <input
    bind:this={inputElement}
    value={value}
    aria-label={label}
    role="combobox"
    aria-autocomplete="list"
    aria-expanded={open}
    aria-controls={listId}
    aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
    oninput={handleInput}
    onkeydown={handleKeydown}
    onclick={() => {
      if (open) return
      query = ''
      void showList()
    }}
  />
  <button
    type="button"
    class="font-picker-toggle"
    tabindex="-1"
    aria-label={`Показать список шрифтов: ${label}`}
    onmousedown={(event) => event.preventDefault()}
    onclick={toggleList}
  >
    <Icon name="chevron-down" size={12} />
  </button>
  {#if open}
    <div class="font-picker-list" id={listId} role="listbox" aria-label={label} bind:this={listElement} style={listStyle}>
      {#each filtered as font, index (font)}
        <button
          id={`${listId}-${index}`}
          type="button"
          tabindex="-1"
          class:active={index === activeIndex}
          class:selected={font === value}
          class="font-picker-option"
          role="option"
          aria-selected={font === value}
          data-font-index={index}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => choose(font)}
        >
          <span class="font-picker-sample" style:font-family={font}>{font}</span>
          {#if font === value}<Icon name="check" size={13} />{/if}
        </button>
      {:else}
        <p class="font-picker-empty">Ничего не найдено. Введите название вручную.</p>
      {/each}
    </div>
  {/if}
</div>
