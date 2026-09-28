<script setup lang="ts">
import {nextTick,onUnmounted,ref,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {compatibleNames,normalizedName,hikvisionInvoke,isDesktop,type HikvisionOrigin,type HikvisionPhoto} from './hikvision';

const props=defineProps<{src?:string;name:string;phone:string;active:boolean;saving:boolean}>();
const emit=defineEmits<{change:[file:File|null|undefined,origin?:HikvisionOrigin];busy:[value:boolean]}>();
const busy=ref(false),removed=ref(false),mismatchOpen=ref(false),mismatchImage=ref(''),mismatchName=ref('');
const desktop=isDesktop();
let generation=0,cropOrigin:HikvisionOrigin|undefined,appliedOrigin:HikvisionOrigin|undefined;
let mismatchResolve:((value:boolean)=>void)|undefined;
function setBusy(value:boolean){busy.value=value;emit('busy',value);}
function finishMismatch(value:boolean){mismatchOpen.value=false;const resolve=mismatchResolve;mismatchResolve=undefined;resolve?.(value);}
async function verifyName(origin:HikvisionOrigin,image:string){
  if(compatibleNames(origin.deviceName,props.name)||origin.approvedName===normalizedName(props.name))return true;
  mismatchName.value=origin.deviceName;mismatchImage.value=image;mismatchOpen.value=true;
  const ok=await new Promise<boolean>(resolve=>{mismatchResolve=resolve;});
  if(ok)origin.approvedName=normalizedName(props.name);return ok;
}
async function validateForSave(){return !appliedOrigin||await verifyName(appliedOrigin,preview.value);}
defineExpose({validateForSave});
async function fetchFromDoor(){
  if(busy.value||props.saving||!/^1[3-9]\d{9}$/.test(props.phone))return;
  const ticket=++generation,phone=props.phone;setBusy(true);
  try{
    const result=await hikvisionInvoke<HikvisionPhoto>('fetch_hikvision_avatar',{phone});
    if(ticket!==generation||!props.active||props.phone!==phone)return;
    const file=new File([new Uint8Array(result.bytes)],'door-avatar.jpg',{type:result.mime});
    const origin:HikvisionOrigin={phone,deviceName:result.deviceName};
    const imageUrl=URL.createObjectURL(file);
    try{if(!await verifyName(origin,imageUrl))return;}finally{URL.revokeObjectURL(imageUrl);}
    if(ticket!==generation||!props.active||props.phone!==phone)return;
    await prepare(file,origin,ticket);
  }catch(e:any){if(ticket===generation&&props.active)ElMessage.error(e.message);}
  finally{if(ticket===generation)setBusy(false);}
}
function invalidate(){generation++;finishMismatch(false);open.value=false;setBusy(false);cropOrigin=undefined;}
watch(()=>props.phone,()=>{invalidate();if(appliedOrigin){appliedOrigin=undefined;if(preview.value)URL.revokeObjectURL(preview.value);preview.value='';removed.value=false;emit('change',undefined);ElMessage.info('手机号已改变，请重新从门禁取得头像');}});
watch(()=>props.active,value=>{if(!value)invalidate();});
const input=ref<HTMLInputElement>();
const canvas=ref<HTMLCanvasElement>();
const open=ref(false);
const dragActive=ref(false);
const zoom=ref(1);
const x=ref(50);
const y=ref(50);
const preview=ref('');
let source:HTMLImageElement|undefined;
let url='';

function draw(){
  if(!source||!canvas.value)return;
  const side=Math.min(source.width,source.height)/zoom.value;
  const sx=(source.width-side)*x.value/100;
  const sy=(source.height-side)*y.value/100;
  canvas.value.getContext('2d')!.drawImage(source,sx,sy,side,side,0,0,256,256);
}

async function prepare(file?:File,origin?:HikvisionOrigin,ticket=++generation){
  if(!file)return;
  if(!['image/jpeg','image/png'].includes(file.type)||file.size>5*1024*1024){
    ElMessage.error('请选择不超过5MB的JPEG或PNG照片');
    return;
  }
  try{
    if(url)URL.revokeObjectURL(url);
    url=URL.createObjectURL(file);
    const image=new Image();
    image.src=url;
    await image.decode();
    if(ticket!==generation||!props.active)return;
    if(image.width*image.height>16000000)throw new Error();
    source=image;
    cropOrigin=origin;
    zoom.value=1;
    x.value=50;
    y.value=50;
    open.value=true;
    await nextTick();
    draw();
  }catch{
    ElMessage.error('图片无法读取或尺寸过大');
  }
}

async function choose(event:Event){
  if(busy.value||props.saving)return;
  const el=event.target as HTMLInputElement;
  const file=el.files?.[0];
  el.value='';
  await prepare(file);
}

async function drop(event:DragEvent){
  if(busy.value||props.saving)return;
  dragActive.value=false;
  await prepare(event.dataTransfer?.files?.[0]);
}

function confirm(){
  const ticket=generation,origin=cropOrigin;
  canvas.value?.toBlob(blob=>{
    if(!blob||ticket!==generation||!props.active)return;
    const file=new File([blob],'avatar.jpg',{type:'image/jpeg'});
    if(preview.value)URL.revokeObjectURL(preview.value);
    preview.value=URL.createObjectURL(blob);
    removed.value=false;appliedOrigin=origin;
    emit('change',file,origin);
    open.value=false;
  },'image/jpeg',0.88);
}

function remove(){
  appliedOrigin=undefined;removed.value=true;
  if(preview.value)URL.revokeObjectURL(preview.value);
  preview.value='';
  emit('change',null);
}

watch([zoom,x,y],draw);
onUnmounted(()=>{
  invalidate();
  if(url)URL.revokeObjectURL(url);
  if(preview.value)URL.revokeObjectURL(preview.value);
});
</script>

<template>
  <div
    class="avatar-editor"
    :class="{'is-dragging':dragActive}"
    @dragenter.prevent="dragActive=true"
    @dragover.prevent="dragActive=true"
    @dragleave.prevent.self="dragActive=false"
    @drop.prevent="drop"
  >
    <button class="avatar-editor-image" :disabled="busy||saving" type="button" aria-label="选择会员头像" @click="input?.click()">
      <img v-if="!removed&&(preview||props.src)" :src="preview||props.src" alt="会员头像"/>
      <span v-else class="avatar-placeholder">无头像</span>
    </button>
    <div class="avatar-editor-copy">
      <b>{{dragActive?'松开即可添加照片':'会员头像（选填）'}}</b>
      <span>点击选择照片，或将图片拖到这里</span>
      <small>JPEG / PNG，最大 5 MB</small>
    </div>
    <div class="avatar-editor-actions">
      <el-button :disabled="busy||saving" @click="input?.click()">选择照片</el-button>
      <el-button v-if="desktop" :loading="busy" :disabled="saving||!/^1[3-9]\d{9}$/.test(phone)" @click="fetchFromDoor">从门禁取得</el-button>
      <small v-if="desktop&&!/^1[3-9]\d{9}$/.test(phone)">请先填写正确的11位手机号</small>
      <el-button v-if="!removed&&(preview||props.src)" :disabled="busy||saving" text @click="remove">移除头像</el-button>
    </div>
    <input ref="input" type="file" accept="image/jpeg,image/png" hidden @change="choose"/>
  </div>
  <el-dialog v-model="open" title="裁剪会员头像" width="400px" append-to-body :close-on-click-modal="false" @opened="draw">
    <canvas ref="canvas" width="256" height="256" class="avatar-crop"/>
    <label>放大<el-slider v-model="zoom" :min="1" :max="3" :step="0.05"/></label>
    <label>左右位置<el-slider v-model="x" :min="0" :max="100"/></label>
    <label>上下位置<el-slider v-model="y" :min="0" :max="100"/></label>
    <template #footer><el-button @click="open=false">取消</el-button><el-button type="primary" @click="confirm">使用此头像</el-button></template>
  </el-dialog>
  <el-dialog v-model="mismatchOpen" title="请核对门禁人员姓名" width="420px" append-to-body :close-on-click-modal="false" @close="finishMismatch(false)">
    <p>门禁姓名：{{mismatchName||'（空）'}}</p><p>会员姓名：{{name||'（空）'}}</p>
    <p>手机号唯一匹配，但姓名不一致，请确认照片是否属于当前会员。</p>
    <img :src="mismatchImage" alt="待核对的门禁照片" style="display:block;max-width:240px;max-height:280px;margin:auto"/>
    <template #footer><el-button @click="finishMismatch(false)">取消</el-button><el-button type="primary" @click="finishMismatch(true)">确认使用</el-button></template>
  </el-dialog>
</template>
