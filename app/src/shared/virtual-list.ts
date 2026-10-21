export interface VirtualRange {
  start: number
  end: number
  top: number
  bottom: number
}

export function getVirtualRange(
  ids: string[],
  measuredHeights: Record<string, number>,
  scrollTop: number,
  viewportHeight: number,
  estimatedHeight = 190,
  overscan = 4,
  gap = 0,
): VirtualRange {
  const heightAt = (index: number) => Math.max(1, measuredHeights[ids[index]!] ?? estimatedHeight) + gap
  const targetStart = Math.max(0, scrollTop - overscan * estimatedHeight)
  const targetEnd = Math.max(0, scrollTop) + Math.max(0, viewportHeight) + overscan * estimatedHeight

  let total = 0
  let top = 0
  let start = 0
  let end = 0
  let visibleEnd = 0
  for (let index = 0; index < ids.length; index += 1) {
    const itemHeight = heightAt(index)
    const next = total + itemHeight
    if (next <= targetStart) {
      top = next
      start = index + 1
    }
    if (total < targetEnd) {
      end = index + 1
      visibleEnd = next
    }
    total = next
  }
  end = Math.max(start, end)
  return {
    start,
    end,
    top,
    bottom: Math.max(0, total - visibleEnd),
  }
}
