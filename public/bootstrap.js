'use strict';

const savedUser = localStorage.getItem('swt-user') || 'zzb';
const savedPw = localStorage.getItem('swt-pw');
if (savedPw) { connect(savedUser, savedPw); }
