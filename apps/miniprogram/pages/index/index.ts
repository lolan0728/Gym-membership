import {request,ensureSession,loadMe,downloadAvatar,uploadAvatar,present,primaryCard,ApiError,notify,type Member} from '../../utils/api';
import {API_BASE} from '../../config';
Page({
  data:{store:{name:'悦体健身',phone:'',hasLogo:true},logoUrl:API_BASE+'/store/logo',member:null as Member|null,card:null as ReturnType<typeof present>|null,avatar:'',initial:'',loading:true,error:'',busy:false,phoneReady:false,accepted:false,avatarBusy:false},
  onShow(){this.refresh();},onPullDownRefresh(){this.refresh().finally(()=>wx.stopPullDownRefresh());},
  async refresh(){
    this.setData({loading:true,error:''});
    try{
      const store=await request('/store','GET',undefined,false);this.setData({store});
      if(!wx.getStorageSync('gym-privacy-accepted')){this.setData({member:null});return;}
      try{const member=await loadMe();const card=primaryCard(member);this.setData({member,card:card?present(card):null,initial:member.name.slice(-1),phoneReady:false});this.setData({avatar:member.avatar_key?await downloadAvatar():''});}
      catch(e){if(e instanceof ApiError&&e.status===403)this.setData({member:null,card:null,avatar:'',phoneReady:true});else throw e;}
    }catch(e){this.setData({error:e instanceof Error?e.message:'加载失败，请重试',member:null,card:null});}finally{this.setData({loading:false});}
  },
  toggleConsent(){this.setData({accepted:!this.data.accepted});},
  async prepare(){
    if(!wx.requirePrivacyAuthorize||!wx.canIUse('button.open-type.getRealtimePhoneNumber')){notify(new Error('请更新微信到最新版本后领取会员卡'));return;}
    if(!this.data.accepted){notify(new Error('请先阅读并同意隐私说明'));return;}
    this.setData({busy:true});
    try{await new Promise<void>((resolve,reject)=>wx.requirePrivacyAuthorize({success:()=>resolve(),fail:()=>reject(new Error('请同意隐私保护指引后领取会员卡'))}));wx.setStorageSync('gym-privacy-accepted',true);await ensureSession();this.setData({phoneReady:true});}
    catch(e){notify(e);}finally{this.setData({busy:false});}
  },
  async bindPhone(event:WechatMiniprogram.CustomEvent){
    if(this.data.busy)return;
    const detail=event.detail as {code?:string;errMsg?:string;errno?:number};
    if(!detail.code){notify(new Error(detail.errno===1400001?'门店手机号验证额度暂不可用，请联系前台':'未完成手机号授权，可重新尝试或联系前台'));return;}
    this.setData({busy:true});try{await request('/wechat/bind','POST',{phoneCode:detail.code});await this.refresh();}catch(e){notify(e);if(e instanceof ApiError&&e.status===401)this.setData({phoneReady:false});}finally{this.setData({busy:false});}
  },
  async chooseAvatar(event:WechatMiniprogram.CustomEvent){
    const path=(event.detail as {avatarUrl?:string}).avatarUrl;if(!path||this.data.avatarBusy)return;
    this.setData({avatarBusy:true});try{await uploadAvatar(path);this.setData({avatar:await downloadAvatar()});wx.showToast({title:'头像已更新',icon:'success'});}catch(e){notify(e);}finally{this.setData({avatarBusy:false});}
  },
  styles(){wx.navigateTo({url:'/pages/styles/styles'});},history(){wx.navigateTo({url:'/pages/history/history'});},privacy(){wx.navigateTo({url:'/pages/privacy/privacy'});},
  contact(){if(this.data.store.phone)wx.makePhoneCall({phoneNumber:this.data.store.phone});else notify(new Error('请到店联系前台'));}
});
