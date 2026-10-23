import { NextRequest, NextResponse } from "next/server";
const canonicalOrigin="https://app.aipi.website";
export function proxy(request:NextRequest){
  const url=request.nextUrl;
  let path=url.pathname;
  if(path==="/dashboard"||path.startsWith("/dashboard/")){
    const key=path.slice("/dashboard".length).replace(/^\/+|\/+$/g,"").replace(/^projects(?:\/|$)/,"");
    path=key?`/workspace/${key}`:"/workspace";
  }else if(path==="/team")path="/workspace";
  else if(path==="/team/dashboard"){
    const key=url.searchParams.get("workspace");path=key&&/^[0-9a-f-]{36}$/i.test(key)?`/workspace/${key}`:"/workspace";
  }
  const legacy:Record<string,string>={"/docs.html":"/docs","/install.html":"/#install","/login.html":"/workspace","/product.html":"/#product","/workflow.html":"/#workflow","/plans.html":"/#cloud"};
  if(legacy[path])path=legacy[path];
  if(path!==url.pathname||url.hostname==="aipi-team-cloud.ceo-935.workers.dev")
    return NextResponse.redirect(new URL(`${path}${url.search}`,canonicalOrigin),{status:307,headers:{"cache-control":"no-store"}});
  return NextResponse.next();
}
export const config={matcher:["/dashboard","/dashboard/:path*","/team","/team/:path*","/docs.html","/install.html","/login.html","/product.html","/workflow.html","/plans.html"]};
