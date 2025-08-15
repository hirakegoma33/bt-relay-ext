// docs/hello-ext.js
export default class HelloExt {
  getInfo(){ return { id:'helloext', name:'HelloExt', blocks:[
    { opcode:'ping', blockType:Scratch.BlockType.COMMAND, text:'PINGを表示' }
  ]}; }
  ping(){ alert('PONG'); }
}
