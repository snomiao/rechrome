// Silent speech fixture generation. AVSpeechSynthesizer.write only; never speak/play.
import Foundation
import AVFoundation

guard CommandLine.arguments.count == 3 else { exit(2) }
let language = CommandLine.arguments[1]
let destination = URL(fileURLWithPath: CommandLine.arguments[2])
let texts = [
  "en-US": "Please answer briefly. What is two plus three? Then say hello in Japanese.",
  "zh-CN": "请简短回答。二加三等于多少？然后用日语说你好。",
  "ja-JP": "短く答えてください。二たす三はいくつですか。そのあと中国語でこんにちはと言ってください。",
  "interrupt": "Stop. Please say only the word blue."
]
guard let text = texts[language], let voice = AVSpeechSynthesisVoice(language: language == "interrupt" ? "en-US" : language) else { exit(3) }
let synthesizer = AVSpeechSynthesizer()
let utterance = AVSpeechUtterance(string: text)
utterance.voice = voice
utterance.rate = AVSpeechUtteranceDefaultSpeechRate
var file: AVAudioFile?
var finished = false
var failed = false
synthesizer.write(utterance) { buffer in
  guard let pcm = buffer as? AVAudioPCMBuffer else { failed = true; finished = true; return }
  if pcm.frameLength == 0 { finished = true; return }
  do {
    if file == nil { file = try AVAudioFile(forWriting: destination, settings: pcm.format.settings) }
    try file!.write(from: pcm)
  } catch { failed = true; finished = true }
}
let deadline = Date().addingTimeInterval(30)
while !finished && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
guard finished && !failed && file != nil else { exit(4) }
print("{\"silentFileWritten\":true}")
