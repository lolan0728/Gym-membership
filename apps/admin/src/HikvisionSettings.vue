<script setup lang="ts">
import {onMounted,reactive,ref} from 'vue';
import {ElMessage} from 'element-plus';
import {hikvisionInvoke,type HikvisionSettings} from './hikvision';
const form=reactive({address:'http://192.168.110.4',username:'admin',password:''});
const saved=ref<HikvisionSettings|null>(null),busy=ref(false);
const changed=()=>!saved.value||form.address!==saved.value.address||form.username!==saved.value.username||!!form.password;
onMounted(async()=>{try{saved.value=await hikvisionInvoke<HikvisionSettings>('hikvision_settings');Object.assign(form,{address:saved.value.address,username:saved.value.username});}catch(e:any){ElMessage.error(e.message);}});
async function save(){busy.value=true;try{saved.value=await hikvisionInvoke<HikvisionSettings>('save_hikvision_settings',{...form});Object.assign(form,{address:saved.value.address,username:saved.value.username,password:''});ElMessage.success('门禁配置已保存在本机');}catch(e:any){ElMessage.error(e.message);}finally{busy.value=false;}}
async function test(){if(changed()){ElMessage.warning('请先保存门禁配置，再测试连接');return;}busy.value=true;try{await hikvisionInvoke('test_hikvision_connection');ElMessage.success('门禁连接及人员读取成功');}catch(e:any){ElMessage.error(e.message);}finally{busy.value=false;}}
</script>
<template>
  <section class="content-panel hikvision-settings" style="margin-top:20px;padding:24px">
    <h2>海康门禁</h2><p>保存门店门禁连接后，可在会员头像处点击“从门禁取得”。更换电脑后需重新配置。</p>
    <el-form label-position="top" :disabled="busy" @submit.prevent><div class="form-grid">
      <el-form-item label="设备地址"><el-input v-model="form.address" placeholder="http://192.168.110.4"/></el-form-item>
      <el-form-item label="门禁用户名"><el-input v-model="form.username" maxlength="128" autocomplete="off"/></el-form-item>
      <el-form-item label="门禁设备密码"><el-input v-model="form.password" type="password" show-password maxlength="256" autocomplete="new-password" :placeholder="saved?.hasPassword?'已保存；地址和用户名不变时可留空':'请输入设备密码，不是 iVMS-4200 软件密码'"/></el-form-item>
    </div><el-button type="primary" :loading="busy" @click="save">保存配置</el-button><el-button :disabled="!saved?.hasPassword" @click="test">测试连接</el-button></el-form>
    <small>诊断日志位于操作日志目录，文件名以 hikvision- 开头。密码保存在 Windows 凭据中，不包含在会员备份内。</small>
  </section>
</template>
<style scoped>
.hikvision-settings h2{font-size:16px;margin:0 0 10px}
.hikvision-settings p{font-size:12px;line-height:1.7;color:#718278;margin:0 0 22px}
.hikvision-settings small{display:block;font-size:12px;line-height:1.7;color:#718278;margin-top:16px}
</style>
