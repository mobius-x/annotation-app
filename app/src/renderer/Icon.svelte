<script lang="ts">
  import { icons } from './icons'

  let { name, size = 16, stroke = 1.7 }: { name: string; size?: number; stroke?: number } = $props()
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={stroke}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>{@html icons[name] ?? icons['file-text']}</svg>
