<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
const paths: Record<string, string> = {
  create: 'M12 3 3 10v10h6v-6h6v6h6V10L12 3Z',
  assets: 'M3 7V5h6l2 2h10v13H3V7Z',
  history: 'M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  decompose: 'M4 3h16v18H4V3Z M8 3v18M16 3v18M4 8h4M4 16h4M16 8h4M16 16h4',
  recognize: 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 12h8M12 8v8',
  plus: 'M12 5v14M5 12h14', close: 'M6 6l12 12M18 6 6 18',
  chevron: 'm9 5 7 7-7 7', down: 'm6 9 6 6 6-6',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
  video: 'M3 5h13v14H3V5Zm13 5 5-3v10l-5-3',
  image: 'M3 3h18v18H3V3Zm0 14 6-6 4 4 3-3 5 5M15 7h.01',
  copy: 'M8 3h12v14H8V3ZM4 7v14h12', search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  play: 'm8 4 12 8-12 8V4Z', check: 'm5 12 4 4L19 6',
  retry: 'M3 10a9 9 0 1 1 1 7M3 3v7h7',
  trash: 'M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  arrow: 'M4 12h16m-6-6 6 6-6 6', download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  info: 'M12 11v6M12 7h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
};
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  ><path :d="paths[name] || paths.info" /></svg>
</template>
