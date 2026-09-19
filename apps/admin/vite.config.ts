import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({plugins:[vue()],server:{port:15173,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:3000',changeOrigin:false}}},build:{chunkSizeWarningLimit:1200}});
