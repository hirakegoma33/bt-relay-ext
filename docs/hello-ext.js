// docs/hello-ext.js  --- Xcratch向けの最小ファクトリ形式
export default function (Scratch) {
  return class HelloExt {
    getInfo() {
      return {
        id: 'helloext',
        name: 'HelloExt',
        blocks: [
          { opcode: 'ping', blockType: Scratch.BlockType.COMMAND, text: 'PINGを表示' }
        ]
      };
    }
    ping() { alert('PONG'); }
  };
}
