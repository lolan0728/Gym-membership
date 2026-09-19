<script setup lang="ts">
import {computed} from 'vue';
import {type Member,mainCard,kindLabel,statusLabels} from './api';
const props=defineProps<{member:Member;storeName:string}>();
const card=computed(()=>mainCard(props.member));
</script>
<template>
  <div class="member-card" :class="`kind-${card?.kind||'year'}`">
    <div class="card-orbit orbit-one"></div><div class="card-orbit orbit-two"></div>
    <div class="card-top"><span class="card-brand">{{storeName}}</span><span class="card-small">MEMBERSHIP</span></div>
    <div class="card-middle"><div><span class="card-caption">YOUR EVERYDAY, STRONGER.</span><h3>{{card?kindLabel(card.kind):'会员卡'}}<span>MEMBER</span></h3></div><img class="card-symbol" src="/brand/joyfit-mark.png" alt=""/></div>
    <div class="card-bottom"><div><b>{{member.name}}</b><span>{{member.card_number}}</span></div><span class="card-status" :class="card?.status">{{card?statusLabels[card.status]:'暂无记录'}}</span></div>
    <div v-if="card" class="card-validity">有效期间 <strong>{{card.start_date.replaceAll('-','.')}} — {{card.end_date.replaceAll('-','.')}}</strong></div>
  </div>
</template>
