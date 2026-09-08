import { createRouter, createWebHistory } from 'vue-router';
export const router = createRouter({ history: createWebHistory(), routes: [
  { path: '/', redirect: '/create' },
  { path: '/create', component: () => import('../features/create/CreatePage.vue') },
  { path: '/assets', component: () => import('../features/assets/AssetsPage.vue') },
  { path: '/history', component: () => import('../features/history/HistoryPage.vue') },
  { path: '/decompose', component: () => import('../features/decompose/DecomposePage.vue') },
  { path: '/recognize', component: () => import('../features/recognize/RecognizePage.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/create' },
] });
