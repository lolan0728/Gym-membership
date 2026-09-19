type ResolvePrivacy=(input:{event:'agree'|'disagree';buttonId?:string})=>void;
const pending=new WeakMap<object,ResolvePrivacy[]>();
Component({
  data:{visible:false,contractName:'用户隐私保护指引'},
  lifetimes:{detached(){for(const resolve of pending.get(this)||[])resolve({event:'disagree'});pending.delete(this);}},
  methods:{
    open(resolve:ResolvePrivacy){pending.set(this,[...(pending.get(this)||[]),resolve]);this.setData({visible:true});wx.getPrivacySetting({success:r=>this.setData({contractName:r.privacyContractName||'用户隐私保护指引'})});},
    contract(){wx.openPrivacyContract({fail:()=>wx.showToast({title:'暂时无法打开隐私指引，请联系门店',icon:'none'})});},
    agree(){for(const resolve of pending.get(this)||[])resolve({event:'agree',buttonId:'gym-agree-privacy'});pending.delete(this);wx.setStorageSync('gym-privacy-accepted',true);this.setData({visible:false});},
    disagree(){for(const resolve of pending.get(this)||[])resolve({event:'disagree'});pending.delete(this);this.setData({visible:false});}
  }
});
