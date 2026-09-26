<script setup lang="ts">
import {ref,watch,onUnmounted,nextTick} from 'vue';
import {ElMessage} from 'element-plus';
const props=defineProps<{src?:string;name:string}>();
const emit=defineEmits<{change:[file:File|null]}>();
const input=ref<HTMLInputElement>(),canvas=ref<HTMLCanvasElement>(),open=ref(false),zoom=ref(1),x=ref(50),y=ref(50),preview=ref('');
let source:HTMLImageElement|undefined,url='';
function draw(){if(!source||!canvas.value)return;const side=Math.min(source.width,source.height)/zoom.value,sx=(source.width-side)*x.value/100,sy=(source.height-side)*y.value/100;canvas.value.getContext('2d')!.drawImage(source,sx,sy,side,side,0,0,256,256);}
async function choose(event:Event){const el=event.target as HTMLInputElement,file=el.files?.[0];el.value='';if(!file)return;if(!['image/jpeg','image/png'].includes(file.type)||file.size>5*1024*1024){ElMessage.error('请选择不超过5MB的JPEG或PNG照片');return;}try{if(url)URL.revokeObjectURL(url);url=URL.createObjectURL(file);const image=new Image();image.src=url;await image.decode();if(image.width*image.height>16000000)throw new Error();source=image;zoom.value=1;x.value=50;y.value=50;open.value=true;await nextTick();draw();}catch{ElMessage.error('图片无法读取或尺寸过大');}}
function confirm(){canvas.value?.toBlob(blob=>{if(!blob)return;const file=new File([blob],'avatar.jpg',{type:'image/jpeg'});if(preview.value)URL.revokeObjectURL(preview.value);preview.value=URL.createObjectURL(blob);emit('change',file);open.value=false;},'image/jpeg',0.85);}
function remove(){if(preview.value)URL.revokeObjectURL(preview.value);preview.value='';emit('change',null);}
watch([zoom,x,y],draw);onUnmounted(()=>{if(url)URL.revokeObjectURL(url);if(preview.value)URL.revokeObjectURL(preview.value);});
</script>
<template><div class="avatar-editor"><img v-if="preview||props.src" :src="preview||props.src" alt="会员头像"/><span v-else class="avatar-placeholder">{{name.slice(-2)||'头像'}}</span><el-button @click="input?.click()">选择照片</el-button><el-button v-if="preview||props.src" text @click="remove">移除头像</el-button><input ref="input" type="file" accept="image/jpeg,image/png" hidden @change="choose"/><small>选填 · JPEG / PNG，最大5MB</small></div><el-dialog v-model="open" title="裁剪会员头像" width="400px" append-to-body :close-on-click-modal="false" @opened="draw"><canvas ref="canvas" width="256" height="256" class="avatar-crop"/><label>放大<el-slider v-model="zoom" :min="1" :max="3" :step="0.05"/></label><label>左右位置<el-slider v-model="x" :min="0" :max="100"/></label><label>上下位置<el-slider v-model="y" :min="0" :max="100"/></label><template #footer><el-button @click="open=false">取消</el-button><el-button type="primary" @click="confirm">使用此头像</el-button></template></el-dialog></template>
