"use client";
import {useEffect} from "react";
export function AuthReturn(){useEffect(()=>{const hash=new URLSearchParams(location.hash.slice(1));if(hash.has("access_token")||hash.has("error_description"))location.replace(`https://app.aipi.website/workspace${location.hash}`);},[]);return null;}
