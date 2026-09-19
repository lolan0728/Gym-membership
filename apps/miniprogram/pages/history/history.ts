import {loadMe,present} from '../../utils/api';
const eventLabels:Record<string,string>={opened:'首次开卡',renewed:'续卡',updated:'修改卡片',voided:'作废卡片',migrated:'历史卡片'};
Page({data:{cards:[] as (ReturnType<typeof present>&{eventLabel:string})[],loading:true,error:''},onShow(){this.load();},async load(){this.setData({loading:true,error:''});try{const me=await loadMe();this.setData({cards:me.cardHistory.map(card=>({...present(card),eventLabel:eventLabels[card.event_type||'']||'会员卡记录'}))});}catch(e){this.setData({error:e instanceof Error?e.message:'加载失败'});}finally{this.setData({loading:false});}}});
