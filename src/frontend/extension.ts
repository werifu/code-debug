import * as vscode from "vscode";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DebugSession } from "vscode-debugadapter";
import { Session } from "inspector";
import { DebugProtocol } from 'vscode-debugprotocol';
import { MI2DebugSession } from "../mibase"
import { isNullOrUndefined } from "util";
import { resolve } from "dns";
import { rejects } from "assert";
import { Z_NO_COMPRESSION } from "zlib";
import { riscvRegNames } from "./webview"
import {startupCmd} from "./fakeMakefile"

export function activate(context: vscode.ExtensionContext) {
	let NEXT_TERM_ID = 1;
	context.subscriptions.push(vscode.commands.registerCommand('core-debugger.launchCoreDebugger', () => {
		vscode.commands.executeCommand("core-debugger.startPanel");//当启动插件时
		const terminal = vscode.window.createTerminal(`CoreDebugger Ext Terminal #${NEXT_TERM_ID++}`);//创建新终端
		terminal.sendText(startupCmd);//启动qemu
		vscode.commands.executeCommand("workbench.action.debug.start");
	}));
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("debugmemory", new MemoryContentProvider()));
	context.subscriptions.push(vscode.commands.registerCommand("code-debug.examineMemoryLocation", examineMemory));
	context.subscriptions.push(vscode.commands.registerCommand("code-debug.getFileNameNoExt", () => {
		if (!vscode.window.activeTextEditor || !vscode.window.activeTextEditor.document || !vscode.window.activeTextEditor.document.fileName) {
			vscode.window.showErrorMessage("No editor with valid file name active");
			return;
		}
		const fileName = vscode.window.activeTextEditor.document.fileName;
		const ext = path.extname(fileName);
		return fileName.substring(0, fileName.length - ext.length);
	}));
	context.subscriptions.push(vscode.commands.registerCommand("code-debug.getFileBasenameNoExt", () => {
		if (!vscode.window.activeTextEditor || !vscode.window.activeTextEditor.document || !vscode.window.activeTextEditor.document.fileName) {
			vscode.window.showErrorMessage("No editor with valid file name active");
			return;
		}
		const fileName = path.basename(vscode.window.activeTextEditor.document.fileName);
		const ext = path.extname(fileName);
		return fileName.substring(0, fileName.length - ext.length);
	}));

	//=========================================================================================
	let currentPanel: vscode.WebviewPanel | undefined = undefined;
	let webviewMemState = [{ from: 0x80200000, length: 16 }, { from: 0x80201000, length: 32 }];
	let kernelInOutBreakpointArgs=1;
	let userDebugFile = 'initproc';//可以修改为其它用户程序名，如matrix
	//========================================================================================


	context.subscriptions.push(
		vscode.commands.registerCommand('core-debugger.startPanel', () => {
			// Create and show a new webview
			currentPanel = vscode.window.createWebviewPanel(
				'core-debugger', // Identifies the type of the webview. Used internally
				'core-debugger', // Title of the panel displayed to the user
				vscode.ViewColumn.Two, // Editor column to show the new webview panel in.
				{
					// Enable scripts in the webview
					enableScripts: true
				} // Webview options. More on these later.
			);
			// And set its HTML content
			currentPanel.webview.html = getWebviewContent("loading reg names", "loading reg values");
			//处理从WebView中传递出的消息
			currentPanel.webview.onDidReceiveMessage(
				message => {
					// vscode.window.showErrorMessage("message");
					if (message.memRangeQuery) {
						webviewMemState = message.memRangeQuery;
					}
					if (message.removeDebugFile) {
						//自定义请求.customRequest函数见/src/mibase.ts
						vscode.debug.activeDebugSession?.customRequest("removeDebugFile", { debugFilepath: os.homedir() + "/rCore-Tutorial-v3/user/target/riscv64gc-unknown-none-elf/release/initproc" });
						//弹出窗口
						vscode.window.showInformationMessage("symbol file `initproc` removed");
					}
					if(message.setKernelInOutBreakpoints){
						vscode.debug.activeDebugSession?.customRequest("setKernelInOutBreakpoints");
						vscode.window.showInformationMessage("Kernel In Out Breakpoints Set")
					}
					if(message.removeAllCliBreakpoints){
						removeAllCliBreakpoints();
						vscode.window.showInformationMessage("All breakpoints including hidden ones are removed.");
					}
					if(message.disableCurrentSpaceBreakpoints){
						vscode.window.showInformationMessage("disableCurrentSpaceBreakpoints received");
						vscode.debug.activeDebugSession?.customRequest("disableCurrentSpaceBreakpoints");
					}
					if(message.updateAllSpacesBreakpointsInfo){
						vscode.debug.activeDebugSession?.customRequest("listBreakpoints");
					}
				},
				undefined,
				context.subscriptions
			);
			///备用
			// vscode.debug.onDidChangeBreakpoints((e)=>{
			// 	vscode.window.showInformationMessage("onDidChangeBreakpoints");
			// })
		})
	);
	let disposable = vscode.debug.registerDebugAdapterTrackerFactory("*", {
		createDebugAdapterTracker() {
			return {
				//监听VSCode即将发送给Debug Adapter的消息
				onWillReceiveMessage:(message)=>{
					//console.log("//////////RECEIVED FROM EDITOR///////////\n "+JSON.stringify(message)+"\n//////////////////\n ");
					
				},
				onWillStartSession: () => { console.log("session started") },
				//监听Debug Adapter发送给VSCode的消息
				onDidSendMessage: (message) => {
					//console.log("//////////MESSAGE///////////\n "+JSON.stringify(message)+"\n//////////////////\n ");
					//TODO use switch case
					if (message.command === "setBreakpoints"){//如果Debug Adapter设置了一个断点
						vscode.debug.activeDebugSession?.customRequest("listBreakpoints");
					}
					if (message.type === "event") {
						//如果（因为断点等）停下
						if (message.event === "stopped") {
							//console.log("webview should update now. sending eventTest");
							vscode.debug.activeDebugSession?.customRequest("eventTest");
							//console.log("evenTest sent. Requesting registersNamesRequest and registersValuesRequest. ")
							//请求寄存器信息
							vscode.debug.activeDebugSession?.customRequest("registersNamesRequest");
							vscode.debug.activeDebugSession?.customRequest("registersValuesRequest");
							//请求内存数据
							webviewMemState.forEach(element => {
								vscode.debug.activeDebugSession?.customRequest("memValuesRequest",element);
							});
							//更新WebView中的断点信息
							vscode.debug.activeDebugSession?.customRequest("listBreakpoints");
							
						}//处理自定义事件
						else if (message.event === "eventTest") {
							//console.log("Extension Received eventTest");
						}
						else if (message.event === "updateRegistersValuesEvent") {
							//向WebView传递消息
							currentPanel.webview.postMessage({ regValues: message.body });
						}
						else if (message.event === "updateRegistersNamesEvent") {
							currentPanel.webview.postMessage({ regNames: message.body });
						}
						else if (message.event === "memValues") {
							currentPanel.webview.postMessage({ memValues: message.body });
						}
						//到达内核态->用户态的边界
						else if (message.event === "kernelToUserBorder") {
							webviewMemState = [];//TODO applyMemStateSet
							// removeAllCliBreakpoints();
							vscode.window.showInformationMessage("switched to "+userDebugFile+" breakpoints");
							vscode.debug.activeDebugSession?.customRequest("addDebugFile", { debugFilepath: os.homedir() + "/rCore-Tutorial-v3/user/target/riscv64gc-unknown-none-elf/release/"+userDebugFile });
							vscode.debug.activeDebugSession?.customRequest("updateCurrentSpace","src/bin/"+userDebugFile+".rs");
							currentPanel.webview.postMessage({ kernelToUserBorder: true });
							vscode.window.showInformationMessage("All breakpoints removed. Symbol file "+userDebugFile+" added. Now you can set user program breakpoints.  line 13 println!(\"aaaaa... recommemded if it's initproc.rs");
							console.log("/////////////////////////kernelToUserBorder///////////////////");
						}
						//当前在内核态
						else if (message.event === "inKernel") {
							currentPanel.webview.postMessage({ inKernel: true });
							//removeAllCliBreakpoints();
							vscode.window.showInformationMessage("switched to kernel breakpoints");
							console.log("/////////////////////////INKERNEL///////////////////");
						}
						else if (message.event === "info") {
							console.log("//////////////INFO///////////");
							console.log(message.body);
						}
						else if(message.event === "showInformationMessage"){
							vscode.window.showInformationMessage(message.body);
						}
						else if(message.event === "listBreakpoints"){
							vscode.window.showInformationMessage('断点信息表格已经更新');
							currentPanel.webview.postMessage({ breakpointsInfo: message.body.data });
						}
					}
					//vscode.debug.activeDebugSession?.customRequest("envokeUpdateDebugWebviewEvent");},
					//onWillReceiveMessage:(message) => {console.log(message);/*vscode.debug.activeDebugSession?.customRequest("envokeUpdateDebugWebviewEvent")*/}

				}
			}
		}
	});
}

const memoryLocationRegex = /^0x[0-9a-f]+$/;

function getMemoryRange(range: string) {
	if (!range)
		return undefined;
	range = range.replace(/\s+/g, "").toLowerCase();
	let index;
	if ((index = range.indexOf("+")) != -1) {
		const from = range.substring(0, index);
		let length = range.substring(index + 1);
		if (!memoryLocationRegex.exec(from))
			return undefined;
		if (memoryLocationRegex.exec(length))
			length = parseInt(length.substring(2), 16).toString();
		return "from=" + encodeURIComponent(from) + "&length=" + encodeURIComponent(length);
	} else if ((index = range.indexOf("-")) != -1) {
		const from = range.substring(0, index);
		const to = range.substring(index + 1);
		if (!memoryLocationRegex.exec(from))
			return undefined;
		if (!memoryLocationRegex.exec(to))
			return undefined;
		return "from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to);
	} else if (memoryLocationRegex.exec(range))
		return "at=" + encodeURIComponent(range);
	else return undefined;
}

function examineMemory() {
	const socketlists = path.join(os.tmpdir(), "code-debug-sockets");
	if (!fs.existsSync(socketlists)) {
		if (process.platform == "win32")
			return vscode.window.showErrorMessage("This command is not available on windows");
		else
			return vscode.window.showErrorMessage("No debugging sessions available");
	}
	fs.readdir(socketlists, (err, files) => {
		if (err) {
			if (process.platform == "win32")
				return vscode.window.showErrorMessage("This command is not available on windows");
			else
				return vscode.window.showErrorMessage("No debugging sessions available");
		}
		const pickedFile = (file) => {
			vscode.window.showInputBox({ placeHolder: "Memory Location or Range", validateInput: range => getMemoryRange(range) === undefined ? "Range must either be in format 0xF00-0xF01, 0xF100+32 or 0xABC154" : "" }).then(range => {
				vscode.window.showTextDocument(vscode.Uri.parse("debugmemory://" + file + "?" + getMemoryRange(range)));
			});
		};
		if (files.length == 1)
			pickedFile(files[0]);
		else if (files.length > 0)
			vscode.window.showQuickPick(files, { placeHolder: "Running debugging instance" }).then(file => pickedFile(file));
		else if (process.platform == "win32")
			return vscode.window.showErrorMessage("This command is not available on windows");
		else
			vscode.window.showErrorMessage("No debugging sessions available");
	});
}

class MemoryContentProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Thenable<string> {
		return new Promise((resolve, reject) => {
			const conn = net.connect(path.join(os.tmpdir(), "code-debug-sockets", uri.authority.toLowerCase()));
			let from, to;
			let highlightAt = -1;
			const splits = uri.query.split("&");
			if (splits[0].split("=")[0] == "at") {
				const loc = parseInt(splits[0].split("=")[1].substring(2), 16);
				highlightAt = 64;
				from = Math.max(loc - 64, 0);
				to = Math.max(loc + 768, 0);
			} else if (splits[0].split("=")[0] == "from") {
				from = parseInt(splits[0].split("=")[1].substring(2), 16);
				if (splits[1].split("=")[0] == "to") {
					to = parseInt(splits[1].split("=")[1].substring(2), 16);
				} else if (splits[1].split("=")[0] == "length") {
					to = from + parseInt(splits[1].split("=")[1]);
				} else return reject("Invalid Range");
			} else return reject("Invalid Range");
			if (to < from)
				return reject("Negative Range");
			conn.write("examineMemory " + JSON.stringify([from, to - from + 1]));
			conn.once("data", data => {
				let formattedCode = "                  00 01 02 03 04 05 06 07  08 09 0A 0B 0C 0D 0E 0F\n";
				let index: number = from;
				const hexString = data.toString();
				let x = 0;
				let asciiLine = "";
				let byteNo = 0;
				for (let i = 0; i < hexString.length; i += 2) {
					if (x == 0) {
						let addr = index.toString(16);
						while (addr.length < 16) addr = '0' + addr;
						formattedCode += addr + "  ";
					}
					index++;

					const digit = hexString.substring(i, i + 2);
					const digitNum = parseInt(digit, 16);
					if (digitNum >= 32 && digitNum <= 126)
						asciiLine += String.fromCharCode(digitNum);
					else
						asciiLine += ".";

					if (highlightAt == byteNo) {
						formattedCode = formattedCode.slice(0, -1) + "[" + digit + "]";
					} else {
						formattedCode += digit + " ";
					}

					if (x == 7)
						formattedCode += " ";

					if (++x >= 16) {
						formattedCode += " " + asciiLine + "\n";
						x = 0;
						asciiLine = "";
					}
					byteNo++;
				}
				if (x > 0) {
					for (let i = 0; i <= 16 - x; i++) {
						formattedCode += "   ";
					}
					if (x >= 8)
						formattedCode = formattedCode.slice(0, -2);
					else
						formattedCode = formattedCode.slice(0, -1);
					formattedCode += asciiLine;
				}
				resolve(center("Memory Range from 0x" + from.toString(16) + " to 0x" + to.toString(16), 84) + "\n\n" + formattedCode);
				conn.destroy();
			});
		});
	}
}

function center(str: string, width: number): string {
	let left = true;
	while (str.length < width) {
		if (left) str = ' ' + str;
		else str = str + ' ';
		left = !left;
	}
	return str;
}
//WebView HTML
function getWebviewContent(regNames?: string, regValues?: string) {
	return `<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>CoreDebugger</title>
		<style type="text/css">
		.stashed {background-color:grey;}
		.current {background-color:green;}
		</style>
		<!-- Bootstrap 的 CSS 文件 -->
		<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@4.6.1/dist/css/bootstrap.min.css">
		<script src="https://cdn.staticfile.org/jquery/1.10.2/jquery.min.js">
		</script>
	</head>
	<body>
	<div class="container">
	<div>
		<button type="button" class="btn btn-info" onclick="removeDebugFile()">remove Debug File (initproc only for now)</button>&nbsp;&nbsp;&nbsp;&nbsp;
		<button type="button" class="btn btn-info" onclick="setKernelInOutBreakpoints()">set kernel in/out breakpoints</button>&nbsp;&nbsp;&nbsp;&nbsp;
		<button type="button" class="btn btn-info" onclick="removeAllCliBreakpoints()">removeAllCliBreakpoints</button>&nbsp;&nbsp;&nbsp;&nbsp;
		<button type="button" class="btn btn-info" onclick="disableCurrentSpaceBreakpoints()">disableCurrentSpaceBreakpoints</button>&nbsp;&nbsp;&nbsp;&nbsp;
		<button type="button" class="btn btn-info" onclick="updateAllSpacesBreakpointsInfo()">updateAllSpacesBreakpointsInfo</button><br>
	</div>
	<div class="table-responsive">
		<table class="table table-striped table-sm">
			<thead>
				<tr>
					<th>name</th>
					<th>value</th>
				</tr>
			</thead>
			<!--寄存器-->
			<tbody id="reg">
			</tbody>
		</table>
	</div>

	<div class="table-responsive">
		<table class="table table-striped table-sm">
			<thead>
				<tr>
					<th>data</th>
					<th>from</th>
					<th>length</th>
				</tr>
			</thead>
			<!--存储器-->
			<tbody id="mem">
			</tbody>
		</table>
	</div>

	<div>Privilege: </div><span id="privilege">loading</span>
	<div>Breakpoints: </div>
	<div id="breakpointsInfo"><br>
		current:<span id = "currentSpace"></span><br>
			<div class="table-responsive">
				<table class="table table-striped table-sm" id="spacesTable">

				</table>
			</div>
	</div>

	</div>
</body>
<script>

	const riscvRegNames = ${riscvRegNames};
	const vscode = acquireVsCodeApi();
	function getMemRangeList(){

		return [{from:0x80200000,length:16},{from:0x80201000,length:32}];
	}
	function memRangeQuery(){
		vscode.postMessage({memRangeQuery:getMemRangeList()});
	}
	function removeDebugFile(){
		vscode.postMessage({removeDebugFile:true});
	}
	function setKernelInOutBreakpoints(){
		vscode.postMessage({setKernelInOutBreakpoints:true});
	}
	function removeAllCliBreakpoints(){
		vscode.postMessage({removeAllCliBreakpoints:true});
	}
	function disableCurrentSpaceBreakpoints(){//不是GDB的disable breakpoints
		vscode.postMessage({disableCurrentSpaceBreakpoints:true});
	}
	function updateAllSpacesBreakpointsInfo(){
		vscode.postMessage({updateAllSpacesBreakpointsInfo:true});
	}
	window.addEventListener('message', event => {
		const message = event.data; // The JSON data our extension sent
		if(message.regValues){
			$("#reg").html("");
			for (var i = 0; i < 33; i++) {
				$("#reg").append("<tr><td>" + riscvRegNames[message.regValues[i][0][1]] + "</td><td>" + message.regValues[i][1][1] + "</td></tr>");
			}
		}
		if(message.memValues){
			let memValues = message.memValues;
			$("#mem").append("<tr><td>" + memValues.data + "</td><td>" + memValues.from + "</td><td>" + memValues.length + "</td></tr>");
		}
		if(message.kernelToUserBorder){
			document.getElementById('privilege').innerHTML='U';
		}
		if(message.inKernel){
			document.getElementById('privilege').innerHTML='S';
		}
		if(message.breakpointsInfo){
			let info = JSON.parse(message.breakpointsInfo);
			document.getElementById('currentSpace').innerHTML=info.current;
			document.getElementById('spacesTable').innerHTML="";
			document.getElementById('spacesTable').innerHTML+="<tr><th>Space</th><th>Path</th><th>breakpoints</th></tr>";
			for(let i = 0;i<info.spaces.length;i++){
				for(let j=0;j<info.spaces[i].setBreakpointsArguments.length;j++){
					let brkptStatus="table-secondary";
					if(info.spaces[i].name===info.current){
						brkptStatus="table-success";
					}
					document.getElementById('spacesTable').innerHTML+="<tr class="+brkptStatus+"><th>"+info.spaces[i].name+"</th><th>"+info.spaces[i].setBreakpointsArguments[j].source.path+"</th><th>"+JSON.stringify(info.spaces[i].setBreakpointsArguments[j].breakpoints)+"</th></tr>"
				}
			}
			
			
		}
	});
    </script>

	</html>`



}

// reset breakpoints in VSCode, Debug Adapter, GDB
function removeAllCliBreakpoints(){ 
	vscode.commands.executeCommand("workbench.debug.viewlet.action.removeAllBreakpoints");//VSCode
	vscode.debug.activeDebugSession?.customRequest("removeAllCliBreakpoints");//Debug Adapter, GDB
}


function getDebugPanelInfo() {

	let result = {
		registers: [{ number: "unknown", value: "loading" }]
	};
	// vscode.debug.activeDebugSession?.customRequest("registersRequest");
	/*
	.then(
		response=>{
			if (response && response.success) {
				console.log("response success. Registers are:");
				console.log(JSON.stringify(response.body.registers));

				result['registers']= response.body.registers;

			} else {
				console.log("response not success! ");
			}
		},
		rejects=>{
			console.log(rejects);
		}
	);
	*/


	//return JSON.stringify(result.registers);
}

