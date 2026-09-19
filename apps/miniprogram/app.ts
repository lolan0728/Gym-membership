App({onLaunch(){
  type ResolvePrivacy=(input:{event:'agree'|'disagree';buttonId?:string})=>void;
  // The platform documentation defines the first argument as a resolve function;
  // the current official typings incorrectly mark it as GeneralCallbackResult.
  if(wx.onNeedPrivacyAuthorization)(wx.onNeedPrivacyAuthorization as unknown as (listener:(resolve:ResolvePrivacy)=>void)=>void)(resolve=>{
    const pages=getCurrentPages(),page=pages[pages.length-1];
    const dialog=page?.selectComponent('#privacy-dialog');
    if(dialog)dialog.open(resolve);else resolve({event:'disagree'});
  });
}});
