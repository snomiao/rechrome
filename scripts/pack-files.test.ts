import {expect,test} from 'bun:test';
import {packedFiles} from './pack-files.cjs';
test('pack guard accepts npm11 array and npm12 named-package manifests',()=>{
 const manifest={name:'rechrome',files:[{path:'rechrome.ts'},{path:'extension\\manifest.json'}]};
 for(const value of [[manifest],{rechrome:manifest}])expect(packedFiles(JSON.stringify(value))).toEqual(['rechrome.ts','extension/manifest.json']);
});
test('pack guard fails closed on absent, ambiguous or malformed manifests',()=>{
 for(const value of [null,[],{},[{files:[]}],{rechrome:{files:[{}]}},[{files:[{path:'one'}]},{files:[{path:'two'}]}],{error:{code:'failure'}}])expect(()=>packedFiles(JSON.stringify(value))).toThrow();
 expect(()=>packedFiles('not json')).toThrow();
});
